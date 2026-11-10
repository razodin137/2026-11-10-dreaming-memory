import { fingerprint, now, transaction } from "./db.js"
import { clearer, sameClaim, similarity } from "./text.js"
import { resolveTopic } from "./subjects.js"

export const KINDS = [ "fact", "gotcha", "convention", "decision" ]
export const SCOPES = [ "project", "global" ]

const HALF_LIFE_DAYS = 45
const RETIRE_BELOW = 0.05
const PROMOTE_MIN_PROJECTS = 2
const MAX_WRITE_ATTEMPTS = 3
const NEAR_DUPLICATE = 0.6
const RETRIEVAL_WEIGHT = 0.2
const USE_WEIGHT = 1

export function remember(db, note, options = { }) {
  const scope = note.scope || "project"
  const kind = note.kind || "fact"
  const sessionId = note.sessionId || note.session_id || null
  if (scope === "global" && sessionId && options.allowGlobal !== true) {
    throw new Error("global notes are read-only to sessions; promote through the dream review gate")
  }
  if (scope === "project" && !note.projectId) {
    throw new Error("a project note needs a project")
  }
  if (sessionId) ensureSessionRow(db, sessionId, note.projectId, note.startedAt)

  const topic = note.topic === undefined || note.topic === null
    ? null
    : resolveExistingTopic(db, { projectId: note.projectId, scope, requested: note.topic })
  const confidence = clamp(note.confidence ?? 0.5)
  const print = fingerprint(note.body)

  if (!print) {
    throw new Error("note body is empty after normalization")
  }

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const exact = db.prepare(`
      SELECT * FROM notes
      WHERE scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND fingerprint = ? AND retired_at IS NULL
    `).get(scope, scope === "global" ? 0 : note.projectId, kind, print)

    if (exact) {
      const merged = mergeNote(db, exact, note, confidence, topic)
      if (merged) return merged
      continue
    }

    if (topic) {
      const near = nearestClaim(db, { scope, projectId: note.projectId, kind, topic, body: note.body })
      if (near) {
        const merged = mergeNote(db, near, note, confidence, topic, { near: true })
        if (merged) return merged
        continue
      }
    }

    const inserted = insertNote(db, note, scope, kind, topic || "general", print, confidence)
    if (inserted) return inserted
  }

  const error = new Error(`note write conflicted ${MAX_WRITE_ATTEMPTS} times; giving up: ${print}`)
  error.code = "NOTE_WRITE_CONFLICT"
  throw error
}

export function resolveExistingTopic(db, { projectId = null, scope = "project", requested }) {
  const rows = db.prepare(`
    SELECT topic, COUNT(*) AS notes FROM notes
    WHERE retired_at IS NULL AND scope = ? AND IFNULL(project_id, 0) = ?
    GROUP BY topic
  `).all(scope, scope === "global" ? 0 : projectId)
  return resolveTopic(requested, rows)
}

function nearestClaim(db, { scope, projectId, kind, topic, body }) {
  const rows = db.prepare(`
    SELECT * FROM notes
    WHERE retired_at IS NULL AND scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND topic = ?
  `).all(scope, scope === "global" ? 0 : projectId, kind, topic)
  let best = null
  let score = 0
  for (const row of rows) {
    if (!sameClaim(body, row.body, { threshold: NEAR_DUPLICATE })) continue
    const similarityScore = similarity(body, row.body)
    if (similarityScore > score) {
      best = row
      score = similarityScore
    }
  }
  return best
}

function mergeNote(db, existing, note, confidence, topic, { near = false } = { }) {
  const body = clearer(note.body, existing.body) ? note.body.trim() : existing.body
  const mergedTopic = topic || existing.topic || "general"
  const examples = encodeExamples(mergeExamples(existing.examples, note.examples))
  const prevalence = note.prevalence || existing.prevalence || null
  const repro = note.repro || existing.repro || null
  const result = db.prepare(`
    UPDATE notes
    SET body = ?,
        fingerprint = ?,
        confidence = MIN(1, MAX(confidence, ?) + 0.05),
        updated_at = ?,
        provenance = ?,
        topic = ?,
        examples = ?,
        prevalence = ?,
        repro = ?,
        version = version + 1
    WHERE id = ? AND version = ?
  `).run(
    body,
    fingerprint(body),
    confidence,
    now(),
    mergeProvenance(existing.provenance, note.provenance),
    mergedTopic,
    examples,
    prevalence,
    repro,
    existing.id,
    existing.version
  )

  if (Number(result.changes) === 0) return null
  return { id: existing.id, created: false, topic: mergedTopic, merged: true, near }
}

function insertNote(db, note, scope, kind, topic, print, confidence) {
  const result = db.prepare(`
    INSERT INTO notes (
      project_id, scope, topic, kind, body, fingerprint, confidence, provenance,
      examples, prevalence, repro, created_at, updated_at, version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
    encodeExamples(note.examples),
    note.prevalence ? String(note.prevalence) : null,
    note.repro || null,
    now(),
    now()
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

export function liveNotes(db, { projectId = null, limit = 1000 } = { }) {
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

export function revisions(db, { noteId = null, runId = null, limit = 50 } = { }) {
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

export function recall(db, { projectId = null, limit = 12, query = null, recordHits = true, signal = "retrieval" } = { }) {
  const rows = query ? search(db, projectId, query) : candidates(db, projectId)
  const ranked = rows
    .filter((row) => !row.retired_at)
    .map((row) => ({ ...row, score: score(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  if (recordHits && ranked.length > 0) {
    const stamp = now()
    transaction(db, () => {
      for (const note of ranked) recordHit(db, note, { projectId, signal, at: stamp })
    })
  }

  return ranked
}

function recordHit(db, note, { projectId = null, signal = "retrieval", at = now() } = { }) {
  const kind = signal === "use" ? "use" : "retrieval"
  const weight = kind === "use" ? USE_WEIGHT : RETRIEVAL_WEIGHT
  db.prepare("INSERT INTO note_hits (note_id, project_id, kind, weight, hit_at) VALUES (?, ?, ?, ?, ?)")
    .run(note.id, projectId, kind, weight, at)
  if (kind === "use") {
    db.prepare("UPDATE notes SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").run(at, note.id)
  } else {
    db.prepare("UPDATE notes SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(at, note.id)
  }
}

export function recordUse(db, { noteId, projectId = null, at = now() }) {
  const note = noteById(db, noteId)
  if (!note) throw new Error(`note ${noteId} not found`)
  transaction(db, () => {
    recordHit(db, note, { projectId, signal: "use", at })
  })
  return noteById(db, noteId)
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

export function score(note, at = new Date(), { retrieval = true } = { }) {
  const touched = retrieval ? note.updated_at : note.last_used_at || note.updated_at
  const ageDays = Math.max(0, (at - new Date(touched)) / 86400000)
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  const uses = Number(note.use_count || 0)
  const shown = retrieval ? 0.15 * Math.log1p(Number(note.hits || 0)) : 0
  const usage = 1 + Math.log1p(uses) + shown
  return note.confidence * recency * usage
}

export function decay(db, { archiveDays = 30 } = { }) {
  const at = new Date()
  return transaction(db, () => {
    const rows = db.prepare("SELECT * FROM notes WHERE retired_at IS NULL").all()
    const update = db.prepare("UPDATE notes SET confidence = ?, retired_at = ? WHERE id = ?")
    const retire = db.prepare("UPDATE notes SET confidence = ?, retired_at = ?, version = version + 1 WHERE id = ?")
    let decayed = 0
    let retired = 0
    for (const note of rows) {
      const next = Number(Math.min(note.confidence, score(note, at, { retrieval: false })).toFixed(4))
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
  const repeated = db.prepare(`
    SELECT fingerprint, kind, COUNT(DISTINCT project_id) AS projects, SUM(hits) AS hits,
           MAX(confidence) AS confidence
    FROM notes
    WHERE scope = 'project' AND retired_at IS NULL
    GROUP BY fingerprint, kind
    HAVING projects >= ?
  `).all(PROMOTE_MIN_PROJECTS)

  let runId = null
  let staged = 0
  transaction(db, () => {
    const insertRun = db.prepare("INSERT INTO dream_runs (started_at) VALUES (?)")
    const insert = db.prepare(`
      INSERT INTO staged (run_id, op, scope, topic, kind, body, confidence, provenance, target_id, reason, replaces, prevalence)
      VALUES (?, 'promote', 'global', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const group of repeated) {
      const copies = db.prepare(`
        SELECT * FROM notes
        WHERE scope = 'project' AND kind = ? AND fingerprint = ? AND retired_at IS NULL
      `).all(group.kind, group.fingerprint)
      if (copies.length < PROMOTE_MIN_PROJECTS) continue
      const source = copies.reduce((best, copy) => (Number(copy.confidence) > Number(best.confidence) ? copy : best), copies[0])
      if (runId === null) runId = Number(insertRun.run(now()).lastInsertRowid)
      insert.run(
        runId,
        source.topic || "general",
        group.kind,
        source.body,
        clamp(Number(group.confidence) + 0.1),
        copies.map((copy) => copy.provenance).filter(Boolean).join(" | "),
        source.id,
        `seen in ${copies.length} projects`,
        JSON.stringify(copies.map((copy) => copy.id)),
        `${copies.length} projects`
      )
      staged += 1
    }
  })

  return { runId, staged, promoted: 0 }
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
  const uses = db.prepare("SELECT COUNT(*) AS n FROM note_hits WHERE kind = 'use'").get().n
  return { live, global, retired, projects, sessions, revisions: revisions_, uses }
}

export function mergeProvenance(existing, incoming) {
  if (!incoming) return existing || ""
  if (!existing) return incoming
  const known = new Set(String(existing).split(" | "))
  known.add(incoming)
  return Array.from(known).join(" | ")
}

export function mergeExamples(existing, incoming) {
  const merged = new Map()
  for (const example of [ ...exampleList(existing), ...exampleList(incoming) ]) {
    merged.set(JSON.stringify(example), example)
  }
  return Array.from(merged.values())
}

export function decodeExamples(value) {
  if (!value) return null
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function encodeExamples(value) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function ensureSessionRow(db, id, projectId, startedAt = null) {
  if (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) return
  db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)")
    .run(id, projectId ?? null, startedAt || now())
}

function exampleList(value) {
  if (!value) return [ ]
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [ value ]
    } catch {
      return [ value ]
    }
  }
  return [ value ]
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value)))
}
