import { fingerprint, now } from "./db.js"
import { remember, resolveExistingTopic } from "./notes.js"
import { byId } from "./projects.js"
import { checkable } from "./text.js"
import { dropper } from "./steering.js"

export function add(db, { sessionId, projectId, topic = "general", kind = "fact", body, confidence = 0.5, provenance = "" }) {
  if (!sessionId) throw new Error("a draft needs a session")
  if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
    throw new Error(`unknown session: ${sessionId}`)
  }
  if (!body || !fingerprint(body)) throw new Error("draft body is empty")
  const subject = resolveExistingTopic(db, { projectId, scope: "project", requested: topic })
  const stamp = now()
  const existing = db.prepare("SELECT * FROM drafts WHERE session_id = ? AND fingerprint = ?").get(sessionId, fingerprint(body))
  if (existing) {
    db.prepare("UPDATE drafts SET body = ?, topic = ?, kind = ?, confidence = ?, provenance = ?, updated_at = ? WHERE id = ?")
      .run(body.trim(), subject, kind, clamp(confidence), provenance, stamp, existing.id)
    return db.prepare("SELECT * FROM drafts WHERE id = ?").get(existing.id)
  }
  const result = db.prepare(`
    INSERT INTO drafts (session_id, project_id, topic, kind, body, fingerprint, confidence, provenance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, projectId, subject, kind, body.trim(), fingerprint(body), clamp(confidence), provenance, stamp, stamp)
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(Number(result.lastInsertRowid))
}

export function list(db, { sessionId, projectId = null } = { }) {
  if (!sessionId) throw new Error("drafts are private; pass a session id")
  if (projectId === null) {
    return db.prepare("SELECT * FROM drafts WHERE session_id = ? ORDER BY id").all(sessionId)
  }
  return db.prepare("SELECT * FROM drafts WHERE session_id = ? AND project_id = ? ORDER BY id").all(sessionId, projectId)
}

export function drop(db, { sessionId, id = null } = { }) {
  if (!sessionId) throw new Error("drafts are private; pass a session id")
  if (id === null) {
    const result = db.prepare("DELETE FROM drafts WHERE session_id = ?").run(sessionId)
    return { dropped: Number(result.changes) }
  }
  const result = db.prepare("DELETE FROM drafts WHERE session_id = ? AND id = ?").run(sessionId, id)
  return { dropped: Number(result.changes) }
}

export function commit(db, { sessionId, id = null, project = null } = { }) {
  if (!sessionId) throw new Error("drafts are private; pass a session id")
  const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId)
  const owner = project || (session && session.project_id ? byId(db, session.project_id) : null)
  const rows = id === null
    ? list(db, { sessionId })
    : db.prepare("SELECT * FROM drafts WHERE session_id = ? AND id = ?").all(sessionId, id)
  const drops = owner ? dropper(owner) : () => false
  const committed = [ ]
  const skipped = [ ]

  for (const row of rows) {
    if (!checkable(row.body)) {
      skipped.push({ id: row.id, reason: "not checkable: add a path, command, version, or file:line" })
      continue
    }
    if (drops(row.body)) {
      skipped.push({ id: row.id, reason: "steering: this claim is not worth remembering" })
      continue
    }
    const result = remember(db, {
      projectId: row.project_id || (owner ? owner.id : null),
      scope: "project",
      topic: row.topic,
      kind: row.kind,
      body: row.body,
      confidence: row.confidence,
      provenance: row.provenance || sessionId,
      sessionId
    })
    db.prepare("DELETE FROM drafts WHERE id = ?").run(row.id)
    committed.push({ id: result.id, draft: row.id, topic: result.topic, near: Boolean(result.near) })
  }

  return { session: sessionId, committed, skipped }
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value)))
}
