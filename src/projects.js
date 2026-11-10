import path from "node:path"
import { now, slugify } from "./db.js"

export function register(db, dir) {
  const absolute = path.resolve(dir)
  const existing = db.prepare("SELECT * FROM projects WHERE path = ?").get(absolute)
  const stamp = now()
  if (existing) {
    db.prepare("UPDATE projects SET last_seen_at = ?, status = 'active' WHERE id = ?").run(stamp, existing.id)
    return { ...existing, last_seen_at: stamp, status: "active", created: false }
  }
  const slug = uniqueSlug(db, slugify(path.basename(absolute)) || "project")
  const result = db.prepare(
    "INSERT INTO projects (slug, path, created_at, last_seen_at) VALUES (?, ?, ?, ?)"
  ).run(slug, absolute, stamp, stamp)
  return {
    id: Number(result.lastInsertRowid),
    slug,
    path: absolute,
    created_at: stamp,
    last_seen_at: stamp,
    status: "active",
    created: true
  }
}

function uniqueSlug(db, base) {
  let candidate = base
  let suffix = 2
  while (db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function byPath(db, dir) {
  return db.prepare("SELECT * FROM projects WHERE path = ?").get(path.resolve(dir)) || null
}

export function bySlug(db, slug) {
  return db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) || null
}

export function byId(db, id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) || null
}

export function touch(db, projectId) {
  db.prepare("UPDATE projects SET last_seen_at = ? WHERE id = ?").run(now(), projectId)
}

export function list(db, { status = null } = {}) {
  if (status) {
    return db.prepare("SELECT * FROM projects WHERE status = ? ORDER BY last_seen_at DESC").all(status)
  }
  return db.prepare("SELECT * FROM projects ORDER BY last_seen_at DESC").all()
}

export function archiveStale(db, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const result = db.prepare(
    "UPDATE projects SET status = 'archived' WHERE status = 'active' AND last_seen_at < ?"
  ).run(cutoff)
  return Number(result.changes)
}
