import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "../src/db.js"
import { apply, collect, fork, packet, propose, proposePromotions, stage, transcripts } from "../src/dream.js"
import { add as draftAdd, commit as draftCommit, list as draftList } from "../src/drafts.js"
import { enrich } from "../src/enrich.js"
import { remember, recall, recordUse, decay } from "../src/notes.js"
import { organize } from "../src/organize.js"
import { byId, register } from "../src/projects.js"
import { end, start } from "../src/sessions.js"
import { recordNote } from "../src/topics.js"
import { ingest as ingestToolCalls, record as recordToolCall, recurring } from "../src/toolcalls.js"
import { checkClaim, verify } from "../src/verify.js"
import { dropper, read as readSteering } from "../src/steering.js"

const SCRATCH = path.join(import.meta.dirname, "..", ".scratch")

function fresh() {
  return migrate(new DatabaseSync(":memory:"))
}

function project(db, name) {
  const dir = path.join(SCRATCH, name)
  fs.mkdirSync(dir, { recursive: true })
  return register(db, dir)
}

function sessionAt(db, id, dir, startedAt, diary = `diary for ${id}`) {
  start(db, { id, dir })
  db.prepare("UPDATE sessions SET started_at = ?, ended_at = ?, diary = ? WHERE id = ?")
    .run(startedAt, startedAt, diary, id)
}

function fileDb(name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, name))
  const dbPath = path.join(dir, "memory.db")
  const db = migrate(new DatabaseSync(dbPath))
  return { dir, dbPath, db }
}

test("a paraphrased claim merges into the note it repeats", () => {
  const db = fresh()
  const alpha = project(db, `repair-near-${Date.now()}`)
  const first = remember(db, {
    projectId: alpha.id,
    topic: "testing",
    kind: "gotcha",
    body: "`npm run check` is the full gate",
    provenance: "s1",
    examples: [ { session: "s1", excerpt: "package.json:13" } ],
    confidence: 0.5
  })

  const second = remember(db, {
    projectId: alpha.id,
    topic: "testing",
    kind: "gotcha",
    body: "The full gate is `npm run check`",
    provenance: "s2",
    examples: [ { session: "s2", excerpt: "package.json:14" } ],
    confidence: 0.6
  })

  assert.equal(second.id, first.id)
  assert.equal(second.created, false)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 1)
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(first.id)
  assert.match(note.body, /npm run check/)
  assert.match(note.provenance, /s1/)
  assert.match(note.provenance, /s2/)
  assert.equal(JSON.parse(note.examples).length, 2)
})

test("a write reuses the topic a future agent already searches", () => {
  const db = fresh()
  const alpha = project(db, `repair-topic-${Date.now()}`)

  const first = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "test-commands",
    kind: "fact",
    body: "`npm run check` is the gate",
    provenance: "s1"
  })
  const second = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "lint-gate",
    kind: "fact",
    body: "the gate also runs `eslint .`",
    provenance: "s2"
  })

  assert.equal(first.topic, "testing")
  assert.equal(second.topic, "testing")

  db.prepare("UPDATE notes SET topic = 'test-commands' WHERE id = ?").run(first.id)
  db.prepare("UPDATE notes SET topic = 'lint-gate' WHERE id = ?").run(second.id)
  const result = organize(db, { projectId: alpha.id, projection: false })

  assert.ok(result.merged >= 1)
  const topics = db.prepare("SELECT DISTINCT topic FROM notes").all().map((row) => row.topic)
  assert.deepEqual(topics, [ "testing" ])
})

test("collect proposes a merge when a repeated claim already exists", () => {
  const { dir, db } = fileDb("repair-diff-")
  const alpha = project(db, `repair-diff-${Date.now()}`)
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z")
  sessionAt(db, "s-b", alpha.path, "2026-11-09T02:00:00.000Z")
  const existing = remember(db, {
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "bin/setup needs redis running",
    provenance: "s0"
  })

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-a",
    candidates: [
      { op: "insert", project: alpha.slug, topic: "deploy", kind: "gotcha", body: "bin/setup needs redis running", provenance: "s-a" }
    ]
  })
  propose(copy, {
    sessionId: "s-b",
    candidates: [
      { op: "insert", project: alpha.slug, topic: "deploy", kind: "gotcha", body: "bin/setup needs redis running", provenance: "s-b" }
    ]
  })
  copy.close()

  const collected = collect(db, forked.out)
  assert.equal(collected.staged, 1)
  const row = db.prepare("SELECT * FROM staged WHERE run_id = ?").get(collected.runId)
  assert.equal(row.op, "merge")
  assert.equal(row.target_id, existing.id)
  assert.match(row.prevalence, /seen in 2 sessions/)

  const applied = apply(db, collected.runId)
  assert.equal(applied.inserted, 0)
  assert.equal(applied.merged, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE retired_at IS NULL").get().n, 1)
})

test("a repeated claim absorbs the duplicate notes it replaces", () => {
  const { dir, db } = fileDb("repair-replaces-")
  const alpha = project(db, `repair-replaces-${Date.now()}`)
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z")
  const insert = db.prepare(`
    INSERT INTO notes (project_id, scope, topic, kind, body, fingerprint, confidence, provenance, created_at, updated_at, version)
    VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  for (const body of [ "full gate is npm run check", "npm run check is the full gate", "the full gate is npm run check" ]) {
    insert.run(alpha.id, "testing", "fact", body, body, 0.5, "s0", "2026-11-01", "2026-11-01")
  }

  const forked = fork(db, { out: path.join(dir, "night.db") })
  const copy = new DatabaseSync(forked.out)
  propose(copy, {
    sessionId: "s-a",
    candidates: [
      { op: "insert", project: alpha.slug, topic: "testing", kind: "fact", body: "npm run check is the full gate", provenance: "s-a" }
    ]
  })
  copy.close()

  const collected = collect(db, forked.out)
  const row = db.prepare("SELECT * FROM staged WHERE run_id = ?").get(collected.runId)
  assert.equal(row.op, "merge")
  assert.equal(JSON.parse(row.replaces).length, 2)

  apply(db, collected.runId)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE retired_at IS NULL").get().n, 1)
})

test("a route and a generated filename stay unknown instead of false", () => {
  const db = fresh()
  const alpha = project(db, `repair-verify-${Date.now()}`)
  remember(db, {
    projectId: alpha.id,
    topic: "routing",
    kind: "fact",
    body: "`/up` is the health route, `/__ribbon/bar.html` is generated, and `index.md` is the index"
  })

  const report = verify(db, { projectId: alpha.id })
  assert.equal(report.false, 0)
  assert.equal(report.unknown, 1)
  assert.equal(report.staged, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staged").get().n, 0)
})

test("checkClaim does not call an unverified route true", () => {
  const check = checkClaim({ body: "health lives at `/up`", scope: "project" }, { dir: SCRATCH })
  assert.equal(check.status, "unknown")
})

test("a candidate resolves to its registered project and falls back to the session", () => {
  const db = fresh()
  const writecam = project(db, "2026-11-06-writecam")
  const listmonk = project(db, "2026-11-06-listmonk")
  sessionAt(db, "s-list", listmonk.path, "2026-11-09T01:00:00.000Z")

  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: "writecam", kind: "fact", body: "the camera uploads through S3", session: "s-list" },
      { op: "insert", project: "book-autopilot", kind: "fact", body: "the list runs on sqlite", session: "s-list" },
      { op: "insert", scope: "project", kind: "fact", body: "a note with no home", project: null }
    ]
  })

  assert.equal(staged.staged, 2)
  assert.equal(staged.problems.length, 1)
  assert.match(staged.problems[0].error, /no project/)
  const rows = db.prepare("SELECT project_slug FROM staged WHERE run_id = ? ORDER BY id").all(staged.runId)
  assert.deepEqual(rows.map((row) => row.project_slug), [ writecam.slug, listmonk.slug ])
  assert.ok(byId(db, writecam.id))
})

test("a session recalls on the way in and commits only checkable lessons on the way out", () => {
  const db = fresh()
  const alpha = project(db, `repair-session-${Date.now()}`)
  remember(db, { projectId: alpha.id, topic: "deploy", kind: "gotcha", body: "bin/deploy needs redis on 6379" })

  const opened = start(db, { id: "s-live", dir: alpha.path })
  assert.equal(opened.notes.length, 1)
  assert.ok(opened.steering)
  assert.equal(opened.notes[0].body, "bin/deploy needs redis on 6379")

  const closed = end(db, {
    id: "s-live",
    lessons: [
      { topic: "deploy", kind: "gotcha", body: "bin/deploy needs redis on 6379" },
      { topic: "deploy", kind: "fact", body: "be careful with migrations" }
    ]
  })

  assert.equal(closed.committed.length, 1)
  assert.equal(closed.skipped.length, 1)
  assert.match(closed.skipped[0].reason, /not checkable/)
  assert.ok(closed.ended_at)

  start(db, { id: "s-quiet", dir: alpha.path })
  const quiet = end(db, { id: "s-quiet", lessons: [] })
  assert.equal(quiet.committed.length, 0)
})

test("retrieval is not use and a never-used note still decays", () => {
  const db = fresh()
  const alpha = project(db, `repair-use-${Date.now()}`)
  const note = remember(db, { projectId: alpha.id, topic: "deploy", kind: "gotcha", body: "deploy needs redis", confidence: 0.5 })

  recall(db, { projectId: alpha.id })
  recall(db, { projectId: alpha.id })
  let stored = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id)
  assert.equal(stored.hits, 2)
  assert.equal(stored.use_count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_hits WHERE kind = 'retrieval'").get().n, 2)

  const used = recordUse(db, { noteId: note.id, projectId: alpha.id })
  assert.equal(used.use_count, 1)
  assert.ok(used.last_used_at)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_hits WHERE kind = 'use'").get().n, 1)

  const stale = remember(db, { projectId: alpha.id, topic: "deploy", kind: "fact", body: "stale deploy hint", confidence: 0.06 })
  db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 400 * 86400000).toISOString(), stale.id)
  for (let index = 0; index < 10; index += 1) recall(db, { projectId: alpha.id })
  const result = decay(db)
  assert.equal(result.retired, 1)
  stored = db.prepare("SELECT retired_at FROM notes WHERE id = ?").get(stale.id)
  assert.ok(stored.retired_at)
})

test("apply writes only the database unless the projection is requested", () => {
  const db = fresh()
  const alpha = project(db, `repair-project-${Date.now()}`)
  const staged = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, topic: "deploy", kind: "fact", body: "deploy uses kamal" }
    ]
  })

  const applied = apply(db, staged.runId)
  assert.equal(applied.inserted, 1)
  assert.deepEqual(applied.files, [ ])
  assert.equal(fs.existsSync(path.join(alpha.path, "memory")), false)

  const second = stage(db, {
    since: null,
    candidates: [
      { op: "insert", project: alpha.slug, topic: "deploy", kind: "fact", body: "deploy also needs redis" }
    ]
  })
  const projected = apply(db, second.runId, { projection: true })
  assert.ok(projected.files.length > 0)
  assert.ok(fs.existsSync(path.join(alpha.path, "memory", "deploy.md")))
})

test("global notes are closed to sessions while project notes and private drafts stay open", () => {
  const db = fresh()
  const alpha = project(db, `repair-perm-${Date.now()}`)
  sessionAt(db, "s-1", alpha.path, "2026-11-09T01:00:00.000Z")
  sessionAt(db, "s-2", alpha.path, "2026-11-09T02:00:00.000Z")

  assert.throws(
    () => remember(db, { projectId: alpha.id, scope: "global", body: "node 26 ships node:sqlite", sessionId: "s-1" }),
    /read-only to sessions/
  )

  const allowed = remember(db, { projectId: alpha.id, body: "bin/setup needs redis on 6379", sessionId: "s-1" })
  assert.ok(allowed.id)

  const draft = draftAdd(db, {
    sessionId: "s-1",
    projectId: alpha.id,
    topic: "deploy",
    kind: "gotcha",
    body: "bin/deploy needs `RAILS_ENV=production`"
  })
  assert.ok(draft.id)
  assert.equal(draftList(db, { sessionId: "s-1" }).length, 1)
  assert.equal(draftList(db, { sessionId: "s-2" }).length, 0)

  const committed = draftCommit(db, { sessionId: "s-1", project: alpha })
  assert.equal(committed.committed.length, 1)
  assert.equal(draftList(db, { sessionId: "s-1" }).length, 0)
})

test("promotion is staged for review, not written straight to global", () => {
  const db = fresh()
  const alpha = project(db, `repair-promote-a-${Date.now()}`)
  const beta = project(db, `repair-promote-b-${Date.now()}`)
  const body = "eslint 10 requires node 20.19 or newer"
  remember(db, { projectId: alpha.id, body })
  remember(db, { projectId: beta.id, body })

  const proposed = proposePromotions(db)
  assert.ok(proposed.runId)
  assert.equal(proposed.staged, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE scope = 'global' AND retired_at IS NULL").get().n, 0)

  const applied = apply(db, proposed.runId)
  assert.equal(applied.promoted, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE scope = 'global' AND retired_at IS NULL").get().n, 1)
})

test("failed tool calls that repeat become a lesson the dream can read", () => {
  const db = fresh()
  const alpha = project(db, `repair-tools-${Date.now()}`)
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z", "")
  sessionAt(db, "s-b", alpha.path, "2026-11-09T02:00:00.000Z", "")

  for (const session of [ "s-a", "s-b" ]) {
    recordToolCall(db, {
      sessionId: session,
      command: "make build-frontend",
      output: "Error: stale assets were served from public/assets",
      exitCode: 1
    })
  }

  const repeated = recurring(db, { projectId: alpha.id })
  assert.equal(repeated.length, 1)
  assert.equal(repeated[0].count, 2)
  assert.equal(repeated[0].attempts, 2)
  assert.deepEqual(repeated[0].sessions.sort(), [ "s-a", "s-b" ])

  const note = remember(db, {
    projectId: alpha.id,
    topic: "build",
    kind: "gotcha",
    body: "make build-frontend can serve stale assets"
  })
  const result = enrich(db, { projectId: alpha.id, since: "2026-11-09T00:00:00.000Z", projection: true })
  assert.equal(result.enriched, 1)
  const stored = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id)
  assert.match(stored.repro, /make build-frontend/)
  assert.match(stored.examples, /stale assets/)
})

test("a transcript's tool calls and results are read as failures", () => {
  const db = fresh()
  const alpha = project(db, `repair-ingest-${Date.now()}`)
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z", "")

  const result = ingestToolCalls(db, {
    sessionId: "s-a",
    events: [
      { type: "tool_use", name: "Bash", input: { command: "make build-frontend" } },
      { type: "tool_result", is_error: true, content: [ { type: "text", text: "Error: stale assets" } ] }
    ]
  })

  assert.equal(result.recorded.length, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].command, "make build-frontend")
  assert.match(result.failed[0].output, /stale assets/)
  assert.equal(recurring(db, { projectId: alpha.id, minSessions: 1 }).length, 1)
})

test("the steering file reaches the session writer and the dream", () => {
  const db = fresh()
  const alpha = project(db, `repair-steer-${Date.now()}`)
  sessionAt(db, "s-a", alpha.path, "2026-11-09T01:00:00.000Z", "a scratch lint command ran")
  const text = readSteering(alpha)
  assert.match(text, /## Drop/)
  assert.equal(dropper(alpha)("scratch lint command formatter output"), true)

  const skipped = recordNote(db, alpha, {
    projectId: alpha.id,
    topic: "testing",
    kind: "fact",
    body: "scratch lint command formatter output"
  })
  assert.equal(skipped.skipped, true)

  const report = packet(db, { since: "2026-11-09T00:00:00.000Z" })
  assert.match(report.projects[0].steering, /## Keep/)

  const listing = transcripts(db, { dir: path.join(SCRATCH, `repair-steer-${Date.now()}`), since: "2026-11-09T00:00:00.000Z" })
  const written = JSON.parse(fs.readFileSync(listing.transcripts[0].path, "utf8"))
  assert.match(written.steering, /## Drop/)
})
