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

export function resolve(db, value) {
  const text = String(value || "").trim()
  if (!text) return null

  const exactPath = byPath(db, text)
  if (exactPath) return exactPath

  const slug = slugify(text)
  const exactSlug = bySlug(db, slug) || bySlug(db, text)
  if (exactSlug) return exactSlug

  const candidates = list(db)
    .map((project) => ({ project, score: projectScore(db, project, text, slug) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.project.last_seen_at).localeCompare(String(a.project.last_seen_at)))
  return candidates.length > 0 ? candidates[0].project : null
}

function projectScore(db, project, text, slug) {
  let score = 0
  if (!slug) return score
  if (project.slug === slug) score = Math.max(score, 100)
  if (project.slug.endsWith(`-${slug}`) || project.slug.endsWith(`_${slug}`)) score = Math.max(score, 85)
  if (slug.endsWith(`-${project.slug}`)) score = Math.max(score, 80)
  if (project.slug.includes(slug)) score = Math.max(score, 65)
  if (slug.includes(project.slug)) score = Math.max(score, 60)

  const wanted = new Set(slug.split("-").filter((part) => part.length >= 3))
  for (const part of project.slug.split("-")) {
    if (part.length >= 3 && wanted.has(part)) score += 8
  }

  const note = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND retired_at IS NULL").get(project.id)
  if (note && note.n > 0 && score > 0) score += Math.min(Number(note.n), 10) / 10
  return score
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
