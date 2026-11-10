import { fingerprint, now, transaction } from "./db.js"
import { KINDS, SCOPES, remember } from "./notes.js"
import { bySlug } from "./projects.js"
import { undistilled } from "./sessions.js"

export const CANDIDATE_SCHEMA = {
  op: "insert | merge | update | retire",
  project: "project slug (omit for global)",
  scope: "project | global",
  kind: "fact | gotcha | convention | decision",
  body: "checkable claim: a path, command, version, or specific gotcha",
  confidence: "0..1",
  provenance: "session id or file:line that this came from",
  target_id: "note id, required for update and retire",
  reason: "why this candidate exists"
}

export function packet(db, { projectId = null, since, limit = 40 } = {}) {
  const sessions = undistilled(db, { since })
  const scoped = projectId
    ? sessions.filter((session) => session.project_id === projectId || session.project_id === null)
    : sessions
  const groups = new Map()
  for (const session of scoped) {
    const key = session.project_slug || "unscoped"
    if (!groups.has(key)) groups.set(key, { slug: key, path: session.project_path, diaries: [ ], notes: [ ] })
    groups.get(key).diaries.push({
      session: session.id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      diary: session.diary
    })
  }
  for (const group of groups.values()) {
    const project = group.slug === "unscoped" ? null : bySlug(db, group.slug)
    group.notes = db.prepare(`
      SELECT id, kind, body, confidence, hits FROM notes
      WHERE retired_at IS NULL AND (scope = 'global' OR project_id = ?)
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(project ? project.id : -1, limit).map((note) => ({ ...note }))
  }
  return {
    generated_at: now(),
    since,
    instructions: [
      "Synthesize the diaries into durable memory notes.",
      "Prefer merging into an existing note over adding a near-duplicate.",
      "Every body must be checkable: a path, a command, a version, or a specific gotcha.",
      "Reject anything that only restates what the code already makes obvious.",
      "Set scope=global only for claims that hold across repositories.",
      "Cite the session id or file:line in provenance."
    ],
    candidate_schema: CANDIDATE_SCHEMA,
    projects: Array.from(groups.values()),
    sessions: scoped.map((session) => session.id)
  }
}

export function stage(db, { candidates, since }) {
  const run = db.prepare("INSERT INTO dream_runs (started_at) VALUES (?)").run(now())
  const runId = Number(run.lastInsertRowid)
  const insert = db.prepare(`
    INSERT INTO staged (run_id, op, project_slug, scope, kind, body, confidence, provenance, target_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const problems = [ ]
  let stagedCount = 0

  transaction(db, () => {
    for (const [ index, candidate ] of candidates.entries()) {
      const error = validate(candidate)
      if (error) {
        problems.push({ index, error })
        continue
      }
      insert.run(
        runId,
        candidate.op,
        candidate.project || null,
        candidate.scope || "project",
        candidate.kind || "fact",
        candidate.body || "",
        clamp(candidate.confidence ?? 0.5),
        candidate.provenance || "",
        candidate.target_id || null,
        candidate.reason || null
      )
      stagedCount += 1
    }
  })

  return { runId, staged: stagedCount, problems, since }
}

export function apply(db, runId) {
  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? AND applied_at IS NULL ORDER BY id").all(runId)
  const counts = { inserted: 0, merged: 0, retired: 0, updated: 0 }
  const problems = [ ]

  transaction(db, () => {
    const finish = db.prepare("UPDATE staged SET applied_at = ? WHERE id = ?")
    for (const row of rows) {
      try {
        applyOne(db, row, counts)
        finish.run(now(), row.id)
      } catch (error) {
        problems.push({ staged_id: row.id, error: error.message })
      }
    }
    db.prepare(`
      UPDATE dream_runs SET finished_at = ?, inserted = ?, merged = ?, retired = ?, promoted = 0, summary = ?
      WHERE id = ?
    `).run(now(), counts.inserted, counts.merged, counts.retired, JSON.stringify({ problems }), runId)
  })

  return { runId, ...counts, problems }
}

function applyOne(db, row, counts) {
  const project = row.project_slug ? bySlug(db, row.project_slug) : null
  if (row.op === "insert" || row.op === "merge") {
    const result = remember(db, {
      projectId: project ? project.id : null,
      scope: row.scope,
      kind: row.kind,
      body: row.body,
      confidence: row.confidence,
      provenance: row.provenance
    })
    if (result.created) counts.inserted += 1
    else counts.merged += 1
    return
  }
  if (row.op === "update") {
    if (!row.target_id) throw new Error("update requires target_id")
    const result = db.prepare("UPDATE notes SET body = ?, fingerprint = ?, confidence = ?, updated_at = ? WHERE id = ?")
      .run(row.body, fingerprint(row.body), row.confidence, now(), row.target_id)
    if (Number(result.changes) === 0) throw new Error(`update target ${row.target_id} not found`)
    counts.updated += 1
    return
  }
  if (row.op === "retire") {
    if (!row.target_id) throw new Error("retire requires target_id")
    const result = db.prepare("UPDATE notes SET retired_at = ? WHERE id = ?").run(now(), row.target_id)
    if (Number(result.changes) === 0) throw new Error(`retire target ${row.target_id} not found`)
    counts.retired += 1
    return
  }
  throw new Error(`unknown op: ${row.op}`)
}

function validate(candidate) {
  if (!candidate || typeof candidate !== "object") return "candidate must be an object"
  if (![ "insert", "merge", "update", "retire" ].includes(candidate.op)) return `bad op: ${candidate.op}`
  if (candidate.scope && !SCOPES.includes(candidate.scope)) return `bad scope: ${candidate.scope}`
  if (candidate.kind && !KINDS.includes(candidate.kind)) return `bad kind: ${candidate.kind}`
  if (candidate.op !== "retire" && !fingerprint(candidate.body || "")) return "empty body"
  if ((candidate.op === "update" || candidate.op === "retire") && !candidate.target_id) {
    return `${candidate.op} requires target_id`
  }
  if (candidate.confidence !== undefined && (candidate.confidence < 0 || candidate.confidence > 1)) {
    return "confidence out of range"
  }
  return null
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value)))
}
