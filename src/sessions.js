import { now, transaction } from "./db.js"
import { register, touch } from "./projects.js"

export function start(db, { id, dir }) {
  const project = register(db, dir)
  const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  const stamp = now()
  if (existing) {
    db.prepare("UPDATE sessions SET project_id = ?, ended_at = NULL WHERE id = ?").run(project.id, id)
    return { session: { ...existing, project_id: project.id, ended_at: null }, project }
  }
  db.prepare("INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)").run(id, project.id, stamp)
  return {
    session: { id, project_id: project.id, started_at: stamp, ended_at: null, diary: null },
    project
  }
}

export function end(db, { id, diary = null }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
  if (!session) throw new Error(`unknown session: ${id}`)
  const stamp = now()
  db.prepare("UPDATE sessions SET ended_at = ?, diary = COALESCE(?, diary) WHERE id = ?")
    .run(stamp, diary, id)
  if (session.project_id) touch(db, session.project_id)
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)
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
    WHERE s.diary IS NOT NULL AND s.diary <> '' AND s.distilled_at IS NULL
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
