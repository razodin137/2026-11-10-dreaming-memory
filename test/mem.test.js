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
import { start } from "../src/sessions.js"
import { apply, collect, fork, formatReview, propose, reject, revert, review, stage, transcripts } from "../src/dream.js"
import { enrich } from "../src/enrich.js"
import { organize } from "../src/organize.js"
import { readTopic, recordNote, syncTopics, topicFile } from "../src/topics.js"
import { verify } from "../src/verify.js"

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

  const staged = promote(db)
  assert.equal(staged.staged, 1)
  const result = apply(db, staged.runId)
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
  assert.equal(staged.staged, 2)
  assert.equal(staged.merged, 1)
  const result = apply(db, staged.runId)
  assert.equal(result.inserted, 1)
  assert.equal(result.merged, 0)
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
  assert.equal(output.staged, 1)

  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)
  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ?").all(output.runId)
  assert.equal(rows.length, 1)
  assert.ok(rows.every((row) => row.applied_at === null))
  db.close()
})

test("dream review describes proposals without applying them", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const existing = remember(db, {
    projectId: alpha.id,
    kind: "gotcha",
    body: "redis listens on 6379",
    provenance: "s1"
  })

  const staged = stage(db, {
    since: null,
    candidates: [
      {
        op: "insert",
        project: alpha.slug,
        kind: "gotcha",
        body: "Redis listens on 6379",
        confidence: 0.7,
        provenance: "s2",
        examples: [ { session: "s9", excerpt: "bin/setup:12" } ],
        prevalence: "7 of 23 sessions"
      },
      { op: "update", target_id: existing.id, body: "redis listens on 6380", confidence: 0.9 },
      { op: "retire", target_id: existing.id }
    ]
  })

  const report = review(db, staged.runId)
  assert.equal(report.proposals, 3)
  assert.equal(report.pending, 3)
  assert.equal(report.applied, 0)
  assert.equal(report.changes[0].target.id, existing.id)
  assert.equal(report.changes[1].target.id, existing.id)
  assert.equal(report.changes[2].target.id, existing.id)

  const text = formatReview(report)
  assert.match(text, /not applied/)
  assert.match(text, /7 of 23 sessions/)
  assert.match(text, /bin\/setup:12/)
  assert.match(text, /before:\s+redis listens on 6379/)
  assert.match(text, /after:\s+redis listens on 6380/)

  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(existing.id).body, "redis listens on 6379")
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staged WHERE applied_at IS NOT NULL").get().n, 0)
})

test("dream review rejects an unknown run", () => {
  const db = fresh()
  assert.throws(() => review(db, 404), /dream run 404 not found/)
})

test("mem dream review prints a human-readable diff and applies nothing", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "review-"))
  const dbPath = path.join(dir, "memory.db")
  const file = path.join(dir, "candidates.json")
  const bin = path.join(import.meta.dirname, "..", "bin", "mem.js")
  fs.writeFileSync(file, JSON.stringify({
    candidates: [
      {
        op: "insert",
        scope: "global",
        kind: "fact",
        body: "node 26 ships node:sqlite",
        confidence: 0.8,
        provenance: "s1",
        examples: [ { session: "s1", excerpt: "src/db.js:3" } ],
        prevalence: "5 of 9 sessions"
      }
    ]
  }))

  execFileSync(process.execPath, [ bin, "init", "--db", dbPath ], { encoding: "utf8" })
  const staged = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "stage", file, "--db", dbPath ],
    { encoding: "utf8" }
  ))

  const stdout = execFileSync(
    process.execPath,
    [ bin, "dream", "review", String(staged.runId), "--db", dbPath ],
    { encoding: "utf8" }
  )

  assert.match(stdout, /dream run 1/)
  assert.match(stdout, /insert\s+global \/ fact\s+confidence 0\.80/)
  assert.match(stdout, /node 26 ships node:sqlite/)
  assert.match(stdout, /5 of 9 sessions/)
  assert.match(stdout, /src\/db\.js:3/)

  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staged WHERE applied_at IS NOT NULL").get().n, 0)
  db.close()
})

test("dream apply commits a reviewed run and is idempotent", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const staged = stage(db, {
    since: null,
    candidates: [
      {
        op: "insert",
        project: alpha.slug,
        kind: "gotcha",
        body: "bin/setup needs redis running",
        provenance: "s1",
        examples: [ { session: "s1", excerpt: "bin/setup:12" } ],
        prevalence: "7 of 9 sessions"
      }
    ]
  })

  assert.equal(review(db, staged.runId).pending, 1)

  const result = apply(db, staged.runId)
  assert.equal(result.inserted, 1)
  assert.equal(result.applied, 1)
  assert.equal(result.pending, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
  assert.equal(review(db, staged.runId).pending, 0)

  const summary = JSON.parse(db.prepare("SELECT summary FROM dream_runs WHERE id = ?").get(staged.runId).summary)
  assert.deepEqual(summary.proposals[0].examples, [ { session: "s1", excerpt: "bin/setup:12" } ])
  assert.equal(summary.proposals[0].prevalence, "7 of 9 sessions")

  const again = apply(db, staged.runId)
  assert.equal(again.inserted, 0)
  assert.equal(again.pending, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
  const kept = JSON.parse(db.prepare("SELECT summary FROM dream_runs WHERE id = ?").get(staged.runId).summary)
  assert.equal(kept.proposals[0].prevalence, "7 of 9 sessions")
})

test("dream reject discards a run and blocks a later apply", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s1" }
    ]
  })

  const result = reject(db, staged.runId)
  assert.equal(result.rejected, true)
  assert.equal(result.already, undefined)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)
  assert.ok(db.prepare("SELECT rejected_at FROM dream_runs WHERE id = ?").get(staged.runId).rejected_at)

  const report = review(db, staged.runId)
  assert.equal(report.pending, 1)
  assert.ok(report.rejected_at)
  assert.match(formatReview(report), /rejected/)
  assert.throws(() => apply(db, staged.runId), /was rejected/)
  assert.equal(reject(db, staged.runId).already, true)
})

test("dream reject refuses a run that has already been applied", () => {
  const db = fresh()
  const alpha = project(db, "alpha")
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s1" }
    ]
  })

  apply(db, staged.runId)
  assert.throws(() => reject(db, staged.runId), /cannot reject/)
})

test("mem dream apply and reject act on staged runs", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "apply-"))
  const dbPath = path.join(dir, "memory.db")
  const file = path.join(dir, "candidates.json")
  const bin = path.join(import.meta.dirname, "..", "bin", "mem.js")
  fs.writeFileSync(file, JSON.stringify({
    candidates: [
      { op: "insert", scope: "global", kind: "fact", body: "node 26 ships node:sqlite", provenance: "s1" }
    ]
  }))

  execFileSync(process.execPath, [ bin, "init", "--db", dbPath ], { encoding: "utf8" })
  const staged = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "stage", file, "--db", dbPath ],
    { encoding: "utf8" }
  ))

  const reviewed = execFileSync(
    process.execPath,
    [ bin, "dream", "review", String(staged.runId), "--db", dbPath ],
    { encoding: "utf8" }
  )
  assert.match(reviewed, /not applied/)

  const applied = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "apply", String(staged.runId), "--db", dbPath ],
    { encoding: "utf8" }
  ))
  assert.equal(applied.inserted, 1)
  assert.equal(applied.pending, 0)

  const second = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "stage", file, "--db", dbPath ],
    { encoding: "utf8" }
  ))
  const rejected = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "reject", String(second.runId), "--db", dbPath ],
    { encoding: "utf8" }
  ))
  assert.equal(rejected.rejected, true)

  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
  assert.ok(db.prepare("SELECT rejected_at FROM dream_runs WHERE id = ?").get(second.runId).rejected_at)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM staged WHERE run_id = ? AND applied_at IS NOT NULL").get(second.runId).n,
    0
  )
  db.close()
})

test("mem dream --apply keeps the one-shot cron path", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "apply-"))
  const dbPath = path.join(dir, "memory.db")
  const file = path.join(dir, "candidates.json")
  const bin = path.join(import.meta.dirname, "..", "bin", "mem.js")
  fs.writeFileSync(file, JSON.stringify({
    candidates: [
      { op: "insert", scope: "global", kind: "fact", body: "node 26 ships node:sqlite", provenance: "s1" }
    ]
  }))

  execFileSync(process.execPath, [ bin, "init", "--db", dbPath ], { encoding: "utf8" })
  const output = JSON.parse(execFileSync(
    process.execPath,
    [ bin, "dream", "--apply", file, "--db", dbPath ],
    { encoding: "utf8" }
  ))

  assert.equal(output.inserted, 1)
  assert.equal(output.pending, 0)
  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
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

  const staged = promote(db)
  apply(db, staged.runId)

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

function fileDb(name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, name))
  const dbPath = path.join(dir, "memory.db")
  const db = migrate(new DatabaseSync(dbPath))
  return { dir, dbPath, db }
}

function sessionAt(db, id, dir, startedAt, diary = `diary for ${id}`) {
  start(db, { id, dir })
  db.prepare("UPDATE sessions SET started_at = ?, ended_at = ?, diary = ? WHERE id = ?")
    .run(startedAt, startedAt, diary, id)
}

test("two subagents proposing the same fact collapse to one note", () => {
  const { dir, db } = fileDb("collect-same-")
  const alpha = project(db, "collect-alpha")
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z")
  sessionAt(db, "s-b", alpha.path, "2026-11-09T02:00:00.000Z")

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-a",
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s-a" }
    ]
  })
  propose(copy, {
    sessionId: "s-b",
    candidates: [
      { op: "insert", project: alpha.slug, kind: "gotcha", body: "bin/setup needs redis running", provenance: "s-b" }
    ]
  })
  copy.close()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)

  const collected = collect(db, forked.out)
  assert.equal(collected.staged, 1)
  assert.equal(collected.already, false)

  const applied = apply(db, collected.runId)
  assert.equal(applied.inserted, 1)
  assert.equal(applied.distilled, 2)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
  assert.equal(applied.source.removed, true)
  assert.equal(fs.existsSync(forked.out), false)
})

test("a stale candidate loses to a newer version", () => {
  const { dir, db } = fileDb("collect-stale-")
  const alpha = project(db, "collect-stale-alpha")
  sessionAt(db, "s-old", alpha.path, "2026-11-09T01:00:00.000Z")
  sessionAt(db, "s-new", alpha.path, "2026-11-09T03:00:00.000Z")
  const note = remember(db, {
    projectId: alpha.id,
    kind: "gotcha",
    body: "redis listens on 6379",
    provenance: "s-old"
  })

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-old",
    candidates: [
      { op: "update", target_id: note.id, body: "redis listens on 6380", provenance: "s-old" }
    ]
  })
  propose(copy, {
    sessionId: "s-new",
    candidates: [
      { op: "update", target_id: note.id, body: "redis listens on 6381", provenance: "s-new" }
    ]
  })
  copy.close()

  const collected = collect(db, forked.out)
  assert.equal(collected.staged, 1)
  assert.equal(collected.superseded, 1)
  assert.equal(collected.superseded_rows[0].session, "s-old")

  const applied = apply(db, collected.runId)
  assert.equal(applied.updated, 1)
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(note.id).body, "redis listens on 6381")
})

test("a candidate cannot overwrite a note version that moved on after the fork", () => {
  const { dir, db } = fileDb("collect-version-")
  const alpha = project(db, "collect-version-alpha")
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z")
  const note = remember(db, {
    projectId: alpha.id,
    kind: "gotcha",
    body: "redis listens on 6379",
    provenance: "s-a"
  })

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-a",
    candidates: [
      { op: "update", target_id: note.id, body: "redis listens on 6380", provenance: "s-a" }
    ]
  })
  copy.close()

  db.prepare("UPDATE notes SET version = version + 1 WHERE id = ?").run(note.id)

  const collected = collect(db, forked.out)
  const applied = apply(db, collected.runId)

  assert.equal(applied.updated, 0)
  assert.equal(applied.problems.length, 1)
  assert.match(applied.problems[0].error, /stale candidate/)
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(note.id).body, "redis listens on 6379")
})

test("collect run twice against the same copy stages the same run", () => {
  const { dir, db } = fileDb("collect-twice-")
  const alpha = project(db, "collect-twice-alpha")
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z")

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-a",
    candidates: [
      { op: "insert", project: alpha.slug, kind: "fact", body: "rake db:prepare owns the schema", provenance: "s-a" }
    ]
  })
  copy.close()

  const first = collect(db, forked.out)
  const second = collect(db, forked.out)

  assert.equal(second.already, true)
  assert.equal(second.runId, first.runId)
  assert.equal(second.staged, first.staged)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM dream_runs WHERE source_fork IS NOT NULL").get().n,
    1
  )
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staged WHERE run_id = ?").get(first.runId).n, 1)
})

test("collect skips candidates it cannot attribute to a session", () => {
  const { dir, db } = fileDb("collect-unattributed-")
  project(db, "collect-unattributed-alpha")

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  stage(copy, {
    since: null,
    candidates: [
      { op: "insert", scope: "global", kind: "fact", body: "floating claim with no session", provenance: "unknown" }
    ]
  })
  copy.close()

  const collected = collect(db, forked.out)
  assert.equal(collected.staged, 0)
  assert.equal(collected.skipped, 1)
  assert.equal(collected.skipped_rows[0].reason, "no session attribution")
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0)
})

test("transcripts writes one file per undistilled session", () => {
  const { dir, db } = fileDb("transcripts-")
  const alpha = project(db, "transcripts-alpha")
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z", "redis was down")
  sessionAt(db, "s-b", alpha.path, "2026-11-09T02:00:00.000Z", "sqlite locked")

  const listing = transcripts(db, { dir: path.join(dir, "transcripts"), since: "2026-11-09T00:00:00.000Z" })
  assert.equal(listing.transcripts.length, 2)

  const first = JSON.parse(fs.readFileSync(listing.transcripts[0].path, "utf8"))
  assert.equal(first.session_id, "s-a")
  assert.match(first.diary, /redis was down/)
  assert.ok(Array.isArray(first.notes))
  assert.ok(first.candidate_schema.session)
})

test("remember writes the subject file and keeps the note id", () => {
  const db = fresh()
  const alpha = project(db, `topic-write-${Date.now()}`)
  const first = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "bin/deploy needs RAILS_ENV=production",
    provenance: "s1",
    confidence: 0.5
  })

  const file = topicFile(alpha, "deploy")
  assert.equal(first.file, file)
  assert.ok(fs.existsSync(file))
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`"id":${first.id}`))
  assert.match(fs.readFileSync(file, "utf8"), /# Deploy/)

  const second = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "bin/deploy needs RAILS_ENV=production",
    provenance: "s2",
    confidence: 0.5
  })
  assert.equal(second.id, first.id)

  const parsed = readTopic(file)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].id, first.id)
  assert.equal(parsed.entries[0].provenance, "s1 | s2")
})

test("the topic helper recovers a stale lock", () => {
  const db = fresh()
  const alpha = project(db, `topic-lock-${Date.now()}`)
  const file = topicFile(alpha, "deploy")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.lock`, "stale")
  const old = new Date(Date.now() - 120000)
  fs.utimesSync(`${file}.lock`, old, old)

  const result = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "fact",
    body: "deploy uses kamal",
    provenance: "s1"
  })

  assert.ok(result.id)
  assert.equal(fs.existsSync(`${file}.lock`), false)
  assert.match(fs.readFileSync(file, "utf8"), /deploy uses kamal/)
})

test("sync writes an index and removes a generated file with no notes", () => {
  const db = fresh()
  const alpha = project(db, `topic-sync-${Date.now()}`)
  recordNote(db, alpha, { projectId: alpha.id, topic: "deploy", kind: "fact", body: "deploy uses kamal" })
  const empty = topicFile(alpha, "unused")
  fs.writeFileSync(empty, "# Unused\n\n<!-- generated by mem. write through `mem remember`, never by hand. -->\n")

  syncTopics(db, alpha)

  assert.ok(fs.existsSync(path.join(alpha.path, "memory", "README.md")))
  assert.equal(fs.existsSync(empty), false)
  assert.match(fs.readFileSync(path.join(alpha.path, "memory", "README.md"), "utf8"), /Deploy/)
})

test("verify confirms a checkable path and raises confidence", () => {
  const db = fresh()
  const alpha = project(db, `verify-true-${Date.now()}`)
  fs.mkdirSync(path.join(alpha.path, "src"), { recursive: true })
  fs.writeFileSync(path.join(alpha.path, "src", "app.js"), "export { }\n")
  const note = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "repo-layout",
    kind: "fact",
    body: "entrypoint is `src/app.js`",
    provenance: "s1",
    confidence: 0.5
  })

  const report = verify(db, { projectId: alpha.id })

  assert.equal(report.true, 1)
  assert.equal(report.false, 0)
  const stored = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id)
  assert.ok(Number(stored.confidence) > 0.5)
  assert.ok(stored.verified_at)
  assert.equal(stored.verify_result, "true")
})

test("verify stages a drop for a missing path and keeps the ledger until apply", () => {
  const db = fresh()
  const alpha = project(db, `verify-false-${Date.now()}`)
  const note = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "deploy needs `src/gone.js`",
    provenance: "s1"
  })

  const report = verify(db, { projectId: alpha.id })
  assert.equal(report.false, 1)
  assert.ok(report.runId)
  assert.equal(db.prepare("SELECT retired_at FROM notes WHERE id = ?").get(note.id).retired_at, null)
  assert.match(formatReview(review(db, report.runId)), /path missing: src\/gone\.js/)

  apply(db, report.runId)

  assert.ok(db.prepare("SELECT retired_at FROM notes WHERE id = ?").get(note.id).retired_at)
  const revision = db.prepare("SELECT * FROM note_revisions WHERE note_id = ? AND run_id = ?").get(note.id, report.runId)
  assert.match(revision.reason, /path missing/)
})

test("verify rewrites a stale version and keeps the reason in a revision", () => {
  const db = fresh()
  const alpha = project(db, `verify-version-${Date.now()}`)
  fs.writeFileSync(path.join(alpha.path, "package.json"), JSON.stringify({
    name: "verify-version",
    devDependencies: { eslint: "^10.2.0" }
  }))
  const note = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "tooling",
    kind: "fact",
    body: "eslint 9 needs flat config",
    provenance: "s1"
  })

  const report = verify(db, { projectId: alpha.id })
  assert.equal(report.false, 1)
  assert.match(formatReview(review(db, report.runId)), /eslint 10 needs flat config/)

  apply(db, report.runId)

  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(note.id).body, "eslint 10 needs flat config")
  const revision = db.prepare("SELECT * FROM note_revisions WHERE note_id = ?").get(note.id)
  assert.equal(revision.body, "eslint 9 needs flat config")
  assert.match(revision.reason, /version mismatch/)
})

test("organize moves a claim to the subject a future agent will search", () => {
  const db = fresh()
  const alpha = project(db, `organize-move-${Date.now()}`)
  recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "fact",
    body: "deploy runs migrations"
  })
  const loose = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "general",
    kind: "gotcha",
    body: "deploy needs redis running"
  })

  const result = organize(db, { projectId: alpha.id, projection: true })

  assert.equal(result.moved, 1)
  assert.equal(db.prepare("SELECT topic FROM notes WHERE id = ?").get(loose.id).topic, "deploy")
  assert.equal(fs.existsSync(topicFile(alpha, "general")), false)
  assert.match(fs.readFileSync(topicFile(alpha, "deploy"), "utf8"), /deploy needs redis running/)
})

test("organize merges topics that converged", () => {
  const db = fresh()
  const alpha = project(db, `organize-merge-${Date.now()}`)
  recordNote(db, alpha, { projectId: alpha.id, topic: "deploy", kind: "fact", body: "deploy uses kamal" })
  const plural = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploys",
    kind: "gotcha",
    body: "deploys need a health check"
  })
  assert.equal(db.prepare("SELECT topic FROM notes WHERE id = ?").get(plural.id).topic, "deploy")
  db.prepare("UPDATE notes SET topic = 'deploys' WHERE id = ?").run(plural.id)

  const result = organize(db, { projectId: alpha.id, projection: true })

  assert.equal(result.merged, 1)
  assert.equal(db.prepare("SELECT topic FROM notes WHERE id = ?").get(plural.id).topic, "deploy")
  assert.equal(fs.existsSync(topicFile(alpha, "deploys")), false)
})

test("organize splits an unwieldy topic by kind", () => {
  const db = fresh()
  const alpha = project(db, `organize-split-${Date.now()}`)
  for (let index = 0; index < 4; index += 1) {
    recordNote(db, alpha, {
      projectId: alpha.id,
      topic: "big",
      kind: "gotcha",
      body: `gotcha number ${index} breaks the build`
    })
    recordNote(db, alpha, {
      projectId: alpha.id,
      topic: "big",
      kind: "fact",
      body: `fact number ${index} explains the build`
    })
  }

  const result = organize(db, { projectId: alpha.id, splitAt: 3, projection: true })

  assert.equal(result.split, 1)
  const topics = db.prepare("SELECT topic, COUNT(*) AS n FROM notes GROUP BY topic ORDER BY topic").all()
  assert.deepEqual(topics.map((row) => row.topic), [ "big", "big-fact" ])
  assert.ok(fs.existsSync(topicFile(alpha, "big-fact")))
})

test("organize cross-links related topic files", () => {
  const db = fresh()
  const alpha = project(db, `organize-link-${Date.now()}`)
  recordNote(db, alpha, { projectId: alpha.id, topic: "deploy", kind: "fact", body: "redis listens on 6379" })
  recordNote(db, alpha, { projectId: alpha.id, topic: "flaky-tests", kind: "gotcha", body: "redis goes flaky under load" })

  organize(db, { projectId: alpha.id, projection: true })

  const deploy = fs.readFileSync(topicFile(alpha, "deploy"), "utf8")
  assert.match(deploy, /## Related/)
  assert.match(deploy, /flaky-tests\.md/)
})

test("enrich adds prevalence, a repro command, and the session that showed it", () => {
  const db = fresh()
  const alpha = project(db, `enrich-${Date.now()}`)
  sessionAt(db, "s-enrich", alpha.path, "2026-11-09T01:00:00.000Z", "deploy failed until we ran `bin/setup`; redis was down")
  const note = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "deploy needs redis",
    provenance: "s1"
  })

  const result = enrich(db, { projectId: alpha.id, since: "2026-11-09T00:00:00.000Z", projection: true })

  assert.equal(result.enriched, 1)
  const stored = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id)
  assert.match(stored.provenance, /s-enrich/)
  assert.equal(stored.prevalence, "1 of 1 sessions")
  assert.match(stored.repro, /bin\/setup/)
  const file = fs.readFileSync(topicFile(alpha, "deploy"), "utf8")
  assert.match(file, /Repro: `bin\/setup`/)
  assert.match(file, /Seen: 1 of 1 sessions/)
})

test("mem remember writes a topic file and mem sync rebuilds the index", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "topic-cli-"))
  const dbPath = path.join(dir, "memory.db")
  const bin = path.join(import.meta.dirname, "..", "bin", "mem.js")

  const output = JSON.parse(execFileSync(process.execPath, [
    bin, "remember", "--path", dir, "--db", dbPath,
    "--topic", "deploy", "--kind", "gotcha", "--body", "deploy needs redis"
  ], { encoding: "utf8" }))

  assert.equal(output.topic, "deploy")
  assert.ok(fs.existsSync(output.file))
  assert.match(fs.readFileSync(output.file, "utf8"), /deploy needs redis/)

  const synced = JSON.parse(execFileSync(process.execPath, [
    bin, "sync", "--path", dir, "--db", dbPath
  ], { encoding: "utf8" }))
  assert.ok(synced.files.some((file) => file.endsWith("README.md")))
})

test("revert restores a run and leaves a revert revision", () => {
  const db = fresh()
  const alpha = project(db, `revert-${Date.now()}`)
  const note = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "redis listens on 6379",
    provenance: "s1"
  })
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "update", target_id: note.id, body: "redis listens on 6380", provenance: "s2" }
    ]
  })
  apply(db, staged.runId)
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(note.id).body, "redis listens on 6380")

  const result = revert(db, staged.runId)

  assert.equal(result.restored, 1)
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(note.id).body, "redis listens on 6379")
  assert.ok(db.prepare("SELECT reverted_at FROM dream_runs WHERE id = ?").get(staged.runId).reverted_at)
  const revision = db.prepare("SELECT * FROM note_revisions WHERE note_id = ? AND cause = 'revert'").get(note.id)
  assert.equal(revision.body, "redis listens on 6380")
  assert.match(formatReview(review(db, staged.runId)), /reverted/)
  assert.equal(revert(db, staged.runId).already, true)
})

test("verify re-runs a safe command when asked", () => {
  const db = fresh()
  const alpha = project(db, `verify-command-${Date.now()}`)
  recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "checks",
    kind: "fact",
    body: "the smoke check passes: `node -e \"process.exit(0)\"`"
  })

  const passing = verify(db, { projectId: alpha.id, execute: true })
  assert.equal(passing.true, 1)
  assert.equal(passing.false, 0)

  recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "checks",
    kind: "fact",
    body: "the broken check fails: `node -e \"process.exit(1)\"`"
  })

  const failing = verify(db, { projectId: alpha.id, execute: true })
  assert.equal(failing.false, 1)
  assert.ok(failing.runId)
  assert.match(formatReview(review(db, failing.runId)), /command failed/)
})

test("verify runs a read-only command without an extra flag", () => {
  const db = fresh()
  const alpha = project(db, `verify-readonly-${Date.now()}`)
  recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "checks",
    kind: "fact",
    body: "node is installed: `node --version`"
  })

  const report = verify(db, { projectId: alpha.id })
  assert.equal(report.true, 1)
  assert.equal(report.runId, null)
})
