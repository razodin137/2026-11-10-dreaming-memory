import { now, transaction } from "./db.js"
import { recall, remember } from "./notes.js"
import { byId, register, touch } from "./projects.js"
import { dropper, read as readSteering } from "./steering.js"
import { checkable } from "./text.js"

export function start(db, { id, dir, limit = 12 }) {
  const project = register(db, dir)
  const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  const stamp = now()
  const session = existing
    ? reopen(db, existing, project.id)
    : create(db, id, project.id, stamp)
  const notes = recall(db, { projectId: project.id, limit, signal: "retrieval" })
  const steering = readSteering(project)
  return { session, project, notes, steering }
}

function create(db, id, projectId, stamp) {
  db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(id, projectId, stamp)
  return { id, project_id: projectId, started_at: stamp, ended_at: null, diary: null }
}

function reopen(db, existing, projectId) {
  db.prepare("UPDATE sessions SET project_id = ?, ended_at = NULL WHERE id = ?").run(projectId, existing.id)
  return { ...existing, project_id: projectId, ended_at: null }
}

export function end(db, { id, diary = null, lessons = [ ], commit = true } = { }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  if (!session) throw new Error(`unknown session: ${id}`)
  const stamp = now()
  db.prepare("UPDATE sessions SET ended_at = ?, diary = COALESCE(?, diary) WHERE id = ?")
    .run(stamp, diary, id)
  if (session.project_id) touch(db, session.project_id)

  let committed = [ ]
  let skipped = [ ]
  if (commit) {
    const result = commitLessons(db, session, lessons)
    committed = result.committed
    skipped = result.skipped
  }

  return { ...db.prepare("SELECT * FROM sessions WHERE id = ?").get(id), committed, skipped }
}

export function commitLessons(db, session, lessons = [ ]) {
  const project = session.project_id ? byId(db, session.project_id) : null
  const drops = project ? dropper(project) : () => false
  const committed = [ ]
  const skipped = [ ]

  for (const lesson of lessons || [ ]) {
    const body = String(lesson.body || "").trim()
    if (!body) {
      skipped.push({ body, reason: "empty" })
      continue
    }
    if (!checkable(body)) {
      skipped.push({ body, reason: "not checkable: add a path, command, version, or file:line" })
      continue
    }
    if (drops(body)) {
      skipped.push({ body, reason: "steering: this claim is not worth remembering" })
      continue
    }
    if (!project) {
      skipped.push({ body, reason: "session has no project" })
      continue
    }
    const result = remember(db, {
      projectId: project.id,
      scope: "project",
      topic: lesson.topic || "general",
      kind: lesson.kind || "fact",
      body,
      confidence: lesson.confidence ?? 0.6,
      provenance: lesson.provenance || `${session.id}`,
      examples: lesson.examples,
      prevalence: lesson.prevalence,
      sessionId: session.id
    })
    committed.push({ id: result.id, topic: result.topic, merged: !result.created })
  }

  return { committed, skipped }
}

export function writeDiary(db, { id, text }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  if (!session) throw new Error(`unknown session: ${id}`)
  db.prepare("UPDATE sessions SET diary = ? WHERE id = ?").run(text, id)
  if (session.project_id) touch(db, session.project_id)
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
}

export function undistilled(db, { since }) {
  return db.prepare(`
    SELECT s.*, p.slug AS project_slug, p.path AS project_path
    FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
    WHERE (s.diary IS NOT NULL AND s.diary <> '' OR EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.id))
      AND s.distilled_at IS NULL
      AND s.started_at >= ?
    ORDER BY s.started_at ASC
  `).all(since)
}

export function markDistilled(db, ids) {
  if (ids.length === 0) return 0
  return transaction(db, () => {
    const statement = db.prepare("UPDATE sessions SET distilled_at = ? WHERE id = ?")
    const stamp = now()
    for (const id of ids) statement.run(stamp, id)
    return ids.length
  })
}
