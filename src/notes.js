import { fingerprint, now, transaction } from "./db.js"

export const KINDS = [ "fact", "gotcha", "convention", "decision" ]
export const SCOPES = [ "project", "global" ]

const HALF_LIFE_DAYS = 45
const RETIRE_BELOW = 0.05
const PROMOTE_MIN_PROJECTS = 2
const MAX_WRITE_ATTEMPTS = 3

export function remember(db, note) {
  const scope = note.scope || "project"
  const kind = note.kind || "fact"
  const topic = note.topic === undefined || note.topic === null ? null : normalizeTopic(note.topic)
  const confidence = clamp(note.confidence ?? 0.5)
  const print = fingerprint(note.body)

  if (!print) {
    throw new Error("note body is empty after normalization")
  }

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const existing = db.prepare(`
      SELECT * FROM notes
      WHERE scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND fingerprint = ? AND retired_at IS NULL
    `).get(scope, scope === "global" ? 0 : note.projectId, kind, print)

    const result = existing
      ? mergeNote(db, existing, confidence, note.provenance, topic, now())
      : insertNote(db, note, scope, kind, topic || "general", print, confidence, now())

    if (result) return result
  }

  const error = new Error(`note write conflicted ${MAX_WRITE_ATTEMPTS} times; giving up: ${print}`)
  error.code = "NOTE_WRITE_CONFLICT"
  throw error
}

function mergeNote(db, existing, confidence, provenance, topic, stamp) {
  const result = db.prepare(`
    UPDATE notes
    SET confidence = MIN(1, MAX(confidence, ?) + 0.05),
        updated_at = ?,
        provenance = ?,
        topic = COALESCE(?, topic),
        version = version + 1
    WHERE id = ? AND version = ?
  `).run(
    confidence,
    stamp,
    mergeProvenance(existing.provenance, provenance),
    topic,
    existing.id,
    existing.version
  )

  if (Number(result.changes) === 0) return null
  return { id: existing.id, created: false, topic: topic || existing.topic || "general" }
}

function insertNote(db, note, scope, kind, topic, print, confidence, stamp) {
  const result = db.prepare(`
    INSERT INTO notes (project_id, scope, topic, kind, body, fingerprint, confidence, provenance, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT DO NOTHING
  `).run(
    scope === "global" ? null : note.projectId,
    scope,
    topic,
    kind,
    note.body.trim(),
    print,
    confidence,
    note.provenance || "",
    stamp,
    stamp
  )

  if (Number(result.changes) === 0) return null
  return { id: Number(result.lastInsertRowid), created: true, topic }
}

export function normalizeTopic(value) {
  const slug = String(value || "general").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "general"
}

export function recordRevision(db, note, { runId = null, sessionId = null, cause = "update", reason = null, at = now() } = {}) {
  db.prepare(`
    INSERT INTO note_revisions (
      note_id, version, project_id, scope, topic, kind, body, fingerprint, confidence,
      provenance, retired_at, run_id, session_id, cause, reason, updated_at, recorded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    note.id,
    note.version,
    note.project_id ?? null,
    note.scope,
    note.topic || "general",
    note.kind,
    note.body,
    note.fingerprint,
    note.confidence,
    note.provenance || "",
    note.retired_at ?? null,
    runId,
    sessionId,
    cause,
    reason,
    note.updated_at,
    at
  )
}

export function liveNotes(db, { projectId = null, limit = 1000 } = {}) {
  return db.prepare(`
    SELECT * FROM notes
    WHERE retired_at IS NULL AND (scope = 'global' OR project_id = ?)
    ORDER BY topic, confidence DESC, id ASC
    LIMIT ?
  `).all(projectId ?? -1, limit)
}

export function noteById(db, id) {
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id) || null
}

export function revisions(db, { noteId = null, runId = null, limit = 50 } = {}) {
  const clauses = [ ]
  const params = [ ]
  if (noteId !== null) {
    clauses.push("note_id = ?")
    params.push(noteId)
  }
  if (runId !== null) {
    clauses.push("run_id = ?")
    params.push(runId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  params.push(limit)
  return db.prepare(`
    SELECT * FROM note_revisions ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params)
}

export function recall(db, { projectId = null, limit = 12, query = null, recordHits = true } = {}) {
  const rows = query ? search(db, projectId, query) : candidates(db, projectId)
  const stamp = now()
  const ranked = rows
    .filter((row) => !row.retired_at)
    .map((row) => ({ ...row, score: score(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  if (recordHits && ranked.length > 0) {
    transaction(db, () => {
      const hit = db.prepare("INSERT INTO note_hits (note_id, project_id, hit_at) VALUES (?, ?, ?)")
      const bump = db.prepare("UPDATE notes SET hits = hits + 1, last_hit_at = ? WHERE id = ?")
      for (const note of ranked) {
        hit.run(note.id, projectId, stamp)
        bump.run(stamp, note.id)
      }
    })
  }

  return ranked
}

function candidates(db, projectId) {
  return db.prepare(`
    SELECT * FROM notes
    WHERE retired_at IS NULL AND (scope = 'global' OR project_id = ?)
    ORDER BY updated_at DESC
    LIMIT 500
  `).all(projectId ?? -1)
}

function search(db, projectId, query) {
  const match = ftsQuery(query)
  if (!match) return [ ]
  return db.prepare(`
    SELECT n.* FROM notes n
    JOIN notes_fts ON notes_fts.rowid = n.id
    WHERE notes_fts MATCH ? AND n.retired_at IS NULL AND (n.scope = 'global' OR n.project_id = ?)
    LIMIT 200
  `).all(match, projectId ?? -1)
}

function ftsQuery(query) {
  const tokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) || [ ]
  return tokens.map((token) => `"${token}"*`).join(" OR ")
}

export function score(note, at = new Date()) {
  const ageDays = Math.max(0, (at - new Date(note.updated_at)) / 86400000)
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  const usage = 1 + Math.log1p(note.hits)
  return note.confidence * recency * usage
}

export function decay(db, { archiveDays = 30 } = {}) {
  const at = new Date()
  return transaction(db, () => {
    const rows = db.prepare("SELECT * FROM notes WHERE retired_at IS NULL").all()
    const update = db.prepare("UPDATE notes SET confidence = ?, retired_at = ? WHERE id = ?")
    const retire = db.prepare("UPDATE notes SET confidence = ?, retired_at = ?, version = version + 1 WHERE id = ?")
    let decayed = 0
    let retired = 0
    for (const note of rows) {
      const next = Number(Math.min(note.confidence, score(note, at)).toFixed(4))
      if (next < RETIRE_BELOW) {
        recordRevision(db, note, { cause: "update", reason: "decay: below retirement threshold" })
        retire.run(next, now(at), note.id)
        retired += 1
      } else if (next < note.confidence) {
        update.run(next, null, note.id)
        decayed += 1
      }
    }
    const stale = db.prepare(`
      UPDATE projects SET status = 'archived' WHERE status = 'active' AND last_seen_at < ?
    `).run(new Date(at.getTime() - archiveDays * 86400000).toISOString())
    return { decayed, retired, archived: Number(stale.changes) }
  })
}

export function promote(db) {
  return transaction(db, () => {
    const repeated = db.prepare(`
      SELECT fingerprint, kind, COUNT(DISTINCT project_id) AS projects, SUM(hits) AS hits,
             MAX(confidence) AS confidence
      FROM notes
      WHERE scope = 'project' AND retired_at IS NULL
      GROUP BY fingerprint, kind
      HAVING projects >= ?
    `).all(PROMOTE_MIN_PROJECTS)

    let promoted = 0
    for (const group of repeated) {
      const copies = db.prepare(`
        SELECT * FROM notes
        WHERE scope = 'project' AND kind = ? AND fingerprint = ? AND retired_at IS NULL
      `).all(group.kind, group.fingerprint)
      if (copies.length < PROMOTE_MIN_PROJECTS) continue

      const body = copies[0].body
      const existing = db.prepare(
        "SELECT * FROM notes WHERE scope = 'global' AND kind = ? AND fingerprint = ? AND retired_at IS NULL"
      ).get(group.kind, group.fingerprint)
      const source = copies.reduce((best, copy) => (copy.confidence > best.confidence ? copy : best), copies[0])
      const priorVersion = Math.max(...copies.map((copy) => copy.version))

      if (existing) {
        db.prepare("UPDATE notes SET confidence = ?, hits = MAX(hits, ?), topic = ?, updated_at = ?, version = version + 1 WHERE id = ?")
          .run(clamp(group.confidence + 0.1), Number(group.hits || 0), source.topic || existing.topic, now(), existing.id)
      } else {
        const result = db.prepare(`
          INSERT INTO notes (project_id, scope, topic, kind, body, fingerprint, confidence, hits, provenance, version, created_at, updated_at)
          VALUES (NULL, 'global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          source.topic || "general",
          group.kind,
          body,
          group.fingerprint,
          clamp(group.confidence + 0.1),
          Number(group.hits || 0),
          copies.map((copy) => copy.provenance).filter(Boolean).join(" | "),
          priorVersion + 1,
          now(),
          now()
        )
        recordRevision(db, { ...source, id: Number(result.lastInsertRowid), version: priorVersion }, {
          cause: "promote"
        })
      }

      const stamp = now()
      for (const copy of copies) {
        db.prepare("UPDATE notes SET retired_at = ? WHERE id = ?").run(stamp, copy.id)
      }
      promoted += 1
    }

    return { promoted }
  })
}

export function stats(db) {
  const live = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE retired_at IS NULL").get().n
  const global = db.prepare(
    "SELECT COUNT(*) AS n FROM notes WHERE retired_at IS NULL AND scope = 'global'"
  ).get().n
  const retired = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE retired_at IS NOT NULL").get().n
  const projects = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'").get().n
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n
  const revisions_ = db.prepare("SELECT COUNT(*) AS n FROM note_revisions").get().n
  return { live, global, retired, projects, sessions, revisions: revisions_ }
}

function mergeProvenance(existing, incoming) {
  if (!incoming) return existing || ""
  if (!existing) return incoming
  const known = new Set(existing.split(" | "))
  known.add(incoming)
  return Array.from(known).join(" | ")
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value)))
}
