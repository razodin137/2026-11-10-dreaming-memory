import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { SCHEMA_PATH, migrate } from "../src/db.js"
import { materialize } from "../src/materialize.js"
import { decay, promote, recall, remember } from "../src/notes.js"
import { register } from "../src/projects.js"
import { apply, stage } from "../src/dream.js"

const SCRATCH = path.join(import.meta.dirname, "..", ".scratch")

function fresh() {
  return migrate(new DatabaseSync(":memory:"))
}

function project(db, name) {
  const dir = path.join(SCRATCH, name)
  fs.mkdirSync(dir, { recursive: true })
  return register(db, dir)
}

function staleRead(db, beforeWrite) {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = target[property]
        return typeof value === "function" ? value.bind(target) : value
      }
      return (sql) => {
        const statement = target.prepare(sql)
        if (!sql.includes("IFNULL(project_id, 0) = ?")) return statement
        return new Proxy(statement, {
          get(stmt, key) {
            if (key === "get") {
              return (...args) => {
                const row = stmt.get(...args)
                if (row) beforeWrite(row)
                return row
              }
            }
            const value = stmt[key]
            return typeof value === "function" ? value.bind(stmt) : value
          }
        })
      }
    }
  })
}

test("remember dedupes on normalized body", () => {
  const db = fresh()
  const first = project(db, "alpha")
  const a = remember(db, { projectId: first.id, body: "Run `npm run lint` before commit." })
  const b = remember(db, { projectId: first.id, body: "run npm run lint before commit" })
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(a.id, b.id)
  const count = db.prepare("SELECT COUNT(*) AS n FROM notes").get().n
  assert.equal(count, 1)
})

test("remember retries and merges after a competing write", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const { id } = remember(db, {
    projectId: alpha.id,
    body: "redis listens on 6379",
    provenance: "s1",
    confidence: 0.5
  })

  let raced = false
  const racing = staleRead(db, (row) => {
    if (raced) return
    raced = true
    db.prepare("UPDATE notes SET confidence = 0.8, provenance = ?, version = version + 1 WHERE id = ?")
      .run("s1 | s2", row.id)
  })

  const result = remember(racing, {
    projectId: alpha.id,
    body: "Redis listens on 6379",
    provenance: "s3",
    confidence: 0.5
  })

  assert.equal(result.id, id)
  assert.equal(result.created, false)
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id)
  assert.equal(note.version, 3)
  assert.equal(Number(note.confidence.toFixed(2)), 0.85)
  assert.equal(note.provenance, "s1 | s2 | s3")
})

test("remember gives up loudly when the note keeps changing", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const { id } = remember(db, { projectId: alpha.id, body: "port 6379", provenance: "s1" })

  let attempts = 0
  const racing = staleRead(db, (row) => {
    attempts += 1
    db.prepare("UPDATE notes SET version = version + 1 WHERE id = ?").run(row.id)
  })

  assert.throws(
    () => remember(racing, { projectId: alpha.id, body: "port 6379", provenance: "s2" }),
    /note write conflicted 3 times/
  )
  assert.equal(attempts, 3)
  assert.equal(db.prepare("SELECT version FROM notes WHERE id = ?").get(id).version, 4)
})

test("migrate adds a version column to an existing database", () => {
  const legacy = fs.readFileSync(SCHEMA_PATH, "utf8")
    .replace("  version INTEGER NOT NULL DEFAULT 1,\n", "")
  const db = new DatabaseSync(":memory:")
  db.exec(legacy)
  db.prepare(`
    INSERT INTO notes (scope, kind, body, fingerprint, provenance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("global", "fact", "old note", "old note", "", "2026-01-01", "2026-01-01")

  migrate(db)

  assert.equal(db.prepare("SELECT version FROM notes").get().version, 1)
})

test("recall is scoped and records hits", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const beta = project(db, "beta")
  remember(db, { projectId: alpha.id, body: "alpha uses postgres on port 5432" })
  remember(db, { projectId: beta.id, body: "beta uses sqlite" })
  remember(db, { projectId: null, scope: "global", body: "node 26 ships node:sqlite" })

  const seen = recall(db, { projectId: alpha.id, recordHits: true })
  const bodies = seen.map((note) => note.body)
  assert.ok(bodies.includes("alpha uses postgres on port 5432"))
  assert.ok(bodies.includes("node 26 ships node:sqlite"))
  assert.ok(!bodies.includes("beta uses sqlite"))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_hits").get().n, seen.length)
})

test("recall matches full text", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  remember(db, { projectId: alpha.id, body: "migrations run through rake db:migrate" })
  remember(db, { projectId: alpha.id, body: "assets compile with propshaft" })
  const hits = recall(db, { projectId: alpha.id, query: "migrations", recordHits: false })
  assert.equal(hits.length, 1)
  assert.match(hits[0].body, /migrations/)
})

test("a note seen in two projects is promoted to global", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const beta = project(db, "beta")
  const body = "eslint 10 requires node 20.19 or newer"
  remember(db, { projectId: alpha.id, body })
  remember(db, { projectId: beta.id, body })

  const result = promote(db)
  assert.equal(result.promoted, 1)
  const global = db.prepare("SELECT * FROM notes WHERE scope = 'global' AND retired_at IS NULL").all()
  assert.equal(global.length, 1)
  assert.equal(global[0].body, body)
  const live = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE scope = 'project' AND retired_at IS NULL").get().n
  assert.equal(live, 0)
})

test("decay retires notes that stop being used", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const { id } = remember(db, { projectId: alpha.id, body: "stale hint", confidence: 0.06 })
  db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 400 * 86400000).toISOString(), id)
  const result = decay(db, { archiveDays: 30 })
  assert.equal(result.retired, 1)
  assert.equal(recall(db, { projectId: alpha.id }).length, 0)
})

test("dream stages then applies candidates deterministically", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s1" },
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s2" },
      { op: "retire", target_id: 999 }
    ]
  })
  assert.equal(staged.staged, 3)
  const result = apply(db, staged.runId)
  assert.equal(result.inserted, 1)
  assert.equal(result.merged, 1)
  assert.equal(result.problems.length, 1)
})

test("dream stage records proposals without touching live memory", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  remember(db, { projectId: alpha.id, kind: "gotcha", body: "redis listens on 6379", provenance: "s1" })
  const before = db.prepare("SELECT id, body, confidence, version FROM notes ORDER BY id").all()

  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s2" },
      { op: "update", target_id: before[0].id, body: "redis listens on 6380", provenance: "s3" }
    ]
  })

  assert.equal(staged.staged, 2)
  assert.equal(staged.problems.length, 0)
  assert.deepEqual(
    db.prepare("SELECT id, body, confidence, version FROM notes ORDER BY id").all(),
    before
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM staged WHERE run_id = ? AND applied_at IS NULL").get(staged.runId).n,
    2
  )
  assert.equal(db.prepare("SELECT finished_at FROM dream_runs WHERE id = ?").get(staged.runId).finished_at, null)
})

test("mem dream stage writes proposals and leaves notes untouched", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "stage-"))
  const dbPath = path.join(dir, "memory.db")
  const file = path.join(dir, "candidates.json")
  const bin = path.join(import.meta.dirname, "..", "bin", "mem.js")
  fs.writeFileSync(file, JSON.stringify({
    candidates: [
      { op: "insert", scope: "global", kind: "fact", body: "node 26 ships node:sqlite", provenance: "s1" },
      { op: "insert", scope: "global", kind: "fact", body: "node 26 ships node:sqlite", provenance: "s2" }
    ]
  }))

  const initialized = JSON.parse(execFileSync(process.execPath, [ bin, "init", "--db", dbPath ], { encoding: "utf8" }))
  assert.equal(initialized.live, 0)

  const output = JSON.parse(execFileSync(process.execPath, [ bin, "dream", "stage", file, "--db", dbPath ], { encoding: "utf8" }))
  assert.equal(output.staged, 2)

  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)
  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ?").all(output.runId)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.applied_at === null))
  db.close()
})

test("applying an update keeps the previous note in note_revisions", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const { id } = remember(db, {
    projectId: alpha.id,
    kind: "gotcha",
    body: "redis listens on 6379",
    provenance: "s1"
  })
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "update", target_id: id, body: "redis listens on 6380", confidence: 0.9, provenance: "s2" }
    ]
  })

  const result = apply(db, staged.runId)

  assert.equal(result.updated, 1)
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(id).body, "redis listens on 6380")
  const revision = db.prepare("SELECT * FROM note_revisions WHERE note_id = ?").get(id)
  assert.equal(revision.body, "redis listens on 6379")
  assert.equal(revision.kind, "gotcha")
  assert.equal(revision.scope, "project")
  assert.equal(revision.version, 1)
  assert.equal(revision.run_id, staged.runId)
  assert.equal(revision.cause, "update")
})

test("a confidence-only merge leaves no revision", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  remember(db, { projectId: alpha.id, body: "redis listens on 6379", provenance: "s1" })
  remember(db, { projectId: alpha.id, body: "redis listens on 6379", provenance: "s2" })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_revisions").get().n, 0)
})

test("promotion keeps the project-scoped version in note_revisions", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const beta = project(db, "beta")
  const body = "eslint 10 requires node 20.19 or newer"
  remember(db, { projectId: alpha.id, body, provenance: "a1" })
  remember(db, { projectId: beta.id, body, provenance: "b1" })

  promote(db)

  const global = db.prepare("SELECT * FROM notes WHERE scope = 'global'").get()
  const revision = db.prepare("SELECT * FROM note_revisions WHERE note_id = ?").get(global.id)
  assert.equal(revision.scope, "project")
  assert.equal(revision.body, body)
  assert.equal(revision.cause, "promote")
  assert.equal(global.version, revision.version + 1)
})

test("materialize writes a read-only projection", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  remember(db, { projectId: alpha.id, kind: "gotcha", body: "seed data lives in db/seeds.rb" })
  remember(db, { projectId: null, scope: "global", body: "prefer fd over find" })
  const output = materialize(db, { project: alpha })
  const written = fs.readFileSync(output.path, "utf8")
  assert.match(written, /generated by mem/)
  assert.match(written, /db\/seeds\.rb/)
  assert.match(written, /prefer fd over find/)
  assert.equal(output.local, 1)
  assert.equal(output.shared, 1)
})
