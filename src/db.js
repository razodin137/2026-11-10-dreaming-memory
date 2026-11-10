import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const SCHEMA_PATH = path.join(ROOT, "schema.sql")
export const DEFAULT_DB = process.env.MEMORY_DB || path.join(ROOT, "memory.db")

export function open(dbPath = DEFAULT_DB) {
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

export function migrate(db) {
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"))
  addColumn(db, "notes", "version", "INTEGER NOT NULL DEFAULT 1")
  addColumn(db, "dream_runs", "rejected_at", "TEXT")
  addColumn(db, "staged", "examples", "TEXT")
  addColumn(db, "staged", "prevalence", "TEXT")
  return db
}

function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some((entry) => entry.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function init(dbPath = DEFAULT_DB) {
  const db = migrate(open(dbPath))
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "1")
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run("created_at", now())
  return db
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function now(date = new Date()) {
  return date.toISOString()
}

export function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function fingerprint(body) {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
