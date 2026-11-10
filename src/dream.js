import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fingerprint, now, open, transaction } from "./db.js"
import { KINDS, SCOPES, recordRevision, remember } from "./notes.js"
import { bySlug } from "./projects.js"
import { markDistilled, undistilled } from "./sessions.js"

export const CANDIDATE_SCHEMA = {
  op: "insert | merge | update | retire",
  project: "project slug (omit for global)",
  scope: "project | global",
  kind: "fact | gotcha | convention | decision",
  body: "checkable claim: a path, command, version, or specific gotcha",
  confidence: "0..1",
  provenance: "session id or file:line that this came from",
  session: "id of the session this candidate came from (required for dream collect)",
  target_id: "note id, required for update and retire",
  reason: "why this candidate exists",
  examples: "array of { session, excerpt } showing the pattern",
  prevalence: "how often it happened, e.g. \"7 of 23 sessions\""
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
    group.notes = existingNotes(db, project ? project.id : -1, limit)
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
      "Cite the session id or file:line in provenance.",
      "Set session to the id of the session each candidate came from so collect can attribute it.",
      "For every candidate, list examples ({ session, excerpt }) and state its prevalence, e.g. \"7 of 23 sessions\"."
    ],
    candidate_schema: CANDIDATE_SCHEMA,
    projects: Array.from(groups.values()),
    sessions: scoped.map((session) => session.id)
  }
}

export function stage(db, { candidates, since, sessionId = null, sourceFork = null, sourcePath = null }) {
  const problems = [ ]
  let stagedCount = 0
  let runId = null

  transaction(db, () => {
    runId = Number(db.prepare(
      "INSERT INTO dream_runs (started_at, source_fork, source_path) VALUES (?, ?, ?)"
    ).run(now(), sourceFork, sourcePath).lastInsertRowid)
    const insert = db.prepare(`
      INSERT INTO staged (run_id, op, project_slug, scope, kind, body, confidence, provenance, target_id, target_version, reason, examples, prevalence, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
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
        candidate.target_version ?? null,
        candidate.reason || null,
        encodeExamples(candidate.examples),
        candidate.prevalence ? String(candidate.prevalence) : null,
        candidate.session_id || candidate.session || sessionId || null
      )
      stagedCount += 1
      const owners = candidate.sessions || [ candidate.session_id || candidate.session || sessionId ]
      for (const owner of owners) {
        if (!owner) continue
        db.prepare("INSERT OR IGNORE INTO run_sessions (run_id, session_id) VALUES (?, ?)").run(runId, owner)
      }
    }
  })

  return { runId, staged: stagedCount, problems, since }
}

export function fork(db, { out = null } = {}) {
  const target = path.resolve(out || process.env.MEM_OUT || defaultForkPath())
  const live = db.prepare("PRAGMA database_list").all().find((entry) => entry.name === "main")
  if (live && live.file && path.resolve(live.file) === target) {
    throw new Error("refusing to fork over the live store")
  }
  for (const suffix of [ "", "-wal", "-shm" ]) {
    fs.rmSync(`${target}${suffix}`, { force: true })
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  db.exec(`VACUUM INTO ${quote(target)}`)

  const copy = open(target)
  const forkId = randomUUID()
  try {
    transaction(copy, () => {
      const put = copy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      put.run("fork_id", forkId)
      put.run("forked_at", now())
    })
  } finally {
    copy.close()
  }

  return { out: target, forkId, bytes: fs.statSync(target).size }
}

export function transcripts(db, { dir = null, since = null, projectId = null, limit = 40 } = {}) {
  const target = path.resolve(dir || path.join(process.cwd(), ".scratch", "dream", "transcripts"))
  fs.mkdirSync(target, { recursive: true })
  const written = [ ]

  for (const session of undistilled(db, { since })) {
    if (projectId !== null && session.project_id !== projectId) continue
    const project = session.project_slug ? bySlug(db, session.project_slug) : null
    const transcript = {
      generated_at: now(),
      session_id: session.id,
      session: {
        id: session.id,
        started_at: session.started_at,
        ended_at: session.ended_at,
        project: session.project_slug || null,
        path: session.project_path || null
      },
      instructions: [
        "Synthesize this one session into durable memory notes.",
        "Prefer merging into an existing note over adding a near-duplicate.",
        "Every body must be checkable: a path, a command, a version, or a specific gotcha.",
        "Reject anything that only restates what the code already makes obvious.",
        "Set scope=global only for claims that hold across repositories.",
        "Set session to this session id so collect can attribute every candidate."
      ],
      candidate_schema: CANDIDATE_SCHEMA,
      diary: session.diary,
      notes: existingNotes(db, project ? project.id : -1, limit)
    }
    const file = path.join(target, `${safeName(session.id)}.json`)
    fs.writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`)
    written.push({ session: session.id, project: session.project_slug || null, path: file })
  }

  return { dir: target, transcripts: written }
}

export function propose(db, { sessionId = null, candidates }) {
  if (sessionId && !db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) {
    throw new Error(`unknown session: ${sessionId}`)
  }
  const attributed = candidates.map((candidate) => {
    const prepared = {
      ...candidate,
      session_id: candidate.session_id || candidate.session || sessionId || null
    }
    if ((candidate.op === "update" || candidate.op === "retire") && candidate.target_id) {
      const note = db.prepare("SELECT version FROM notes WHERE id = ?").get(candidate.target_id)
      prepared.target_version = candidate.target_version ?? (note ? note.version : null)
    }
    return prepared
  })
  return stage(db, { candidates: attributed, since: null, sessionId })
}

export function collect(db, sourcePath) {
  if (!sourcePath || sourcePath === true) throw new Error("missing MEM_OUT path")
  const source = path.resolve(sourcePath)
  if (!fs.existsSync(source)) throw new Error(`dream copy not found: ${source}`)

  const copy = open(source)
  try {
    const forkId = readMeta(copy, "fork_id") || `manual:${source}`
    const existing = db.prepare("SELECT id FROM dream_runs WHERE source_fork = ?").get(forkId)
    if (existing) {
      return {
        runId: Number(existing.id),
        staged: countRun(db, existing.id),
        already: true,
        skipped: 0,
        superseded: 0
      }
    }

    const rows = copy.prepare(`
      SELECT staged.*, sessions.started_at AS session_started_at
      FROM staged LEFT JOIN sessions ON sessions.id = staged.session_id
      ORDER BY sessions.started_at ASC, staged.id ASC
    `).all()
    const reduced = reduceStaged(rows)
    const staged = stage(db, {
      candidates: reduced.proposals,
      since: null,
      sourceFork: forkId,
      sourcePath: source
    })

    return {
      ...staged,
      already: false,
      skipped: reduced.skipped.length,
      superseded: reduced.superseded.length,
      skipped_rows: reduced.skipped,
      superseded_rows: reduced.superseded
    }
  } finally {
    copy.close()
  }
}

function reduceStaged(rows) {
  const byFact = new Map()
  const byTarget = new Map()
  const proposals = [ ]
  const skipped = [ ]
  const superseded = [ ]

  for (const row of rows) {
    if (!row.session_id || !row.session_started_at) {
      skipped.push({ staged_id: row.id, session: row.session_id || null, reason: "no session attribution" })
      continue
    }
    if ((row.op === "update" || row.op === "retire") && !row.target_id) {
      skipped.push({ staged_id: row.id, session: row.session_id, reason: `${row.op} has no target_id` })
      continue
    }

    const candidate = {
      op: row.op,
      project: row.project_slug || null,
      scope: row.scope,
      kind: row.kind,
      body: row.body,
      confidence: Number(row.confidence),
      provenance: row.provenance || null,
      target_id: row.target_id || null,
      target_version: row.target_version ?? null,
      reason: row.reason || null,
      examples: decodeExamples(row.examples),
      prevalence: row.prevalence || null,
      session: row.session_id,
      sessions: [ row.session_id ],
      staged_id: row.id
    }

    if (row.op === "update" || row.op === "retire") {
      const prior = byTarget.get(row.target_id)
      if (prior) {
        superseded.push({
          staged_id: prior.staged_id,
          session: prior.session,
          target_id: row.target_id,
          superseded_by: row.session_id
        })
        proposals[proposals.indexOf(prior)] = candidate
      } else {
        proposals.push(candidate)
      }
      byTarget.set(row.target_id, candidate)
      continue
    }

    const key = `${row.scope}|${row.project_slug || ""}|${row.kind}|${fingerprint(row.body)}`
    const prior = byFact.get(key)
    if (prior) mergeCandidate(prior, candidate)
    else {
      proposals.push(candidate)
      byFact.set(key, candidate)
    }
  }

  return { proposals, skipped, superseded }
}

function mergeCandidate(into, from) {
  into.body = from.body
  into.confidence = Math.max(into.confidence, from.confidence)
  into.provenance = mergeText(into.provenance, from.provenance)
  into.examples = mergeExamples(into.examples, from.examples)
  into.prevalence = from.prevalence || into.prevalence
  into.reason = from.reason || into.reason
  into.session = from.session
  into.sessions = Array.from(new Set([ ...into.sessions, ...from.sessions ]))
}

export function cleanupFork(db, runId) {
  const run = db.prepare("SELECT source_path FROM dream_runs WHERE id = ?").get(runId)
  if (!run || !run.source_path) return null

  let removed = false
  for (const suffix of [ "", "-wal", "-shm" ]) {
    const file = `${run.source_path}${suffix}`
    if (!fs.existsSync(file)) continue
    fs.rmSync(file, { force: true })
    if (suffix === "") removed = true
  }
  return { path: run.source_path, removed }
}

function existingNotes(db, projectId, limit = 40) {
  return db.prepare(`
    SELECT id, kind, body, confidence, hits FROM notes
    WHERE retired_at IS NULL AND (scope = 'global' OR project_id = ?)
    ORDER BY confidence DESC, updated_at DESC
    LIMIT ?
  `).all(projectId, limit).map((note) => ({ ...note }))
}

function defaultForkPath() {
  const stamp = now().replace(/[:.]/g, "-")
  return path.join(process.cwd(), ".scratch", `dream-${stamp}.db`)
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function quote(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function readMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  return row ? row.value : null
}

function countRun(db, runId) {
  return db.prepare("SELECT COUNT(*) AS n FROM staged WHERE run_id = ?").get(runId).n
}

function mergeText(existing, incoming) {
  if (!incoming) return existing || null
  if (!existing) return incoming
  const known = new Set(existing.split(" | "))
  known.add(incoming)
  return Array.from(known).join(" | ")
}

function mergeExamples(existing, incoming) {
  const merged = new Map()
  for (const example of [ ...exampleList(existing), ...exampleList(incoming) ]) {
    merged.set(JSON.stringify(example), example)
  }
  const values = Array.from(merged.values())
  return values.length > 0 ? values : null
}

function exampleList(value) {
  if (!value) return [ ]
  if (Array.isArray(value)) return value
  return [ value ]
}

export function review(db, runId) {
  const run = requireRun(db, runId)
  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? ORDER BY id").all(runId)
  const applied = rows.filter((row) => row.applied_at).length
  return {
    runId: Number(runId),
    started_at: run.started_at,
    finished_at: run.finished_at,
    rejected_at: run.rejected_at || null,
    proposals: rows.length,
    applied,
    pending: rows.length - applied,
    changes: rows.map((row) => describe(db, row))
  }
}

export function formatReview(report) {
  const count = `${report.proposals} proposal${report.proposals === 1 ? "" : "s"}`
  let status = "not applied"
  if (report.rejected_at) status = "rejected"
  else if (report.pending === 0) status = "applied"
  else if (report.applied > 0) status = "partially applied"
  const lines = [ `dream run ${report.runId} — ${count}, ${status}`, "" ]

  if (report.changes.length === 0) {
    lines.push("(no proposals staged)")
    return lines.join("\n")
  }

  for (const [ index, change ] of report.changes.entries()) {
    lines.push(...formatChange(change, index + 1))
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

function formatChange(change, index) {
  const confidence = Number(change.confidence).toFixed(2)
  const target = change.target ? `  -> note #${change.target.id}` : ""
  const marker = change.applied_at ? "  [applied]" : ""
  const lines = [
    `${index}. ${change.op}  ${change.project} / ${change.kind}  confidence ${confidence}${target}${marker}`
  ]

  if (change.op === "update") {
    lines.push(field("before:", change.target ? change.target.body : "(target missing)"))
    lines.push(field("after:", change.body))
  } else if (change.op === "retire") {
    lines.push(field("note:", change.target ? change.target.body : "(target missing)"))
  } else {
    lines.push(field("note:", change.body))
    lines.push(field("merges:", change.target
      ? `#${change.target.id} ${change.target.body}`
      : "(new note)"))
  }

  lines.push(field("evidence:", formatExamples(change.examples) || "(none)"))
  lines.push(field("prevalence:", change.prevalence || "(not given)"))
  if (change.provenance) lines.push(field("provenance:", change.provenance))
  if (change.reason) lines.push(field("reason:", change.reason))

  return lines
}

function describe(db, row) {
  const project = row.project_slug ? bySlug(db, row.project_slug) : null
  return {
    id: row.id,
    op: row.op,
    project: row.project_slug || "global",
    scope: row.scope,
    kind: row.kind,
    body: row.body,
    confidence: Number(row.confidence),
    provenance: row.provenance || null,
    reason: row.reason || null,
    examples: decodeExamples(row.examples),
    prevalence: row.prevalence || null,
    target: targetFor(db, row, project),
    applied_at: row.applied_at || null
  }
}

function targetFor(db, row, project) {
  if (row.op === "update" || row.op === "retire") {
    if (!row.target_id) return null
    return noteSummary(db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id))
  }
  const projectId = row.scope === "global" ? 0 : project ? project.id : 0
  return noteSummary(db.prepare(`
    SELECT * FROM notes
    WHERE scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND fingerprint = ? AND retired_at IS NULL
  `).get(row.scope, projectId, row.kind, fingerprint(row.body)))
}

function noteSummary(note) {
  if (!note) return null
  return {
    id: note.id,
    scope: note.scope,
    kind: note.kind,
    body: note.body,
    confidence: Number(note.confidence)
  }
}

function field(label, value) {
  return `   ${label.padEnd(12)}${value}`
}

function summarizeProposals(rows) {
  return rows.map((row) => ({
    id: row.id,
    op: row.op,
    project: row.project_slug || "global",
    body: row.body,
    confidence: Number(row.confidence),
    provenance: row.provenance || null,
    examples: decodeExamples(row.examples),
    prevalence: row.prevalence || null
  }))
}

function encodeExamples(value) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function decodeExamples(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function formatExamples(examples) {
  if (!examples) return null
  if (!Array.isArray(examples)) return String(examples)
  return examples.map((example) => {
    if (example && typeof example === "object") {
      const where = example.session || example.id || ""
      const excerpt = example.excerpt || example.file || example.line || ""
      return [ where, excerpt ].filter(Boolean).join(" at ")
    }
    return String(example)
  }).join("; ")
}

export function apply(db, runId) {
  const run = requireRun(db, runId)
  if (run.rejected_at) throw new Error(`dream run ${runId} was rejected; nothing to apply`)

  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? AND applied_at IS NULL ORDER BY id").all(runId)
  const counts = { inserted: 0, merged: 0, retired: 0, updated: 0 }
  const problems = [ ]

  transaction(db, () => {
    const finish = db.prepare("UPDATE staged SET applied_at = ? WHERE id = ?")
    for (const row of rows) {
      try {
        applyOne(db, row, counts, runId)
        finish.run(now(), row.id)
      } catch (error) {
        problems.push({ staged_id: row.id, error: error.message })
      }
    }
    const pending = pendingCount(db, runId)
    const stagedRows = db.prepare("SELECT * FROM staged WHERE run_id = ? ORDER BY id").all(runId)
    db.prepare(`
      UPDATE dream_runs
      SET finished_at = COALESCE(?, finished_at),
          inserted = inserted + ?,
          merged = merged + ?,
          retired = retired + ?,
          promoted = 0,
          summary = ?
      WHERE id = ?
    `).run(
      pending === 0 ? now() : null,
      counts.inserted,
      counts.merged,
      counts.retired,
      JSON.stringify({ problems, proposals: summarizeProposals(stagedRows) }),
      runId
    )
  })

  const sessionIds = db.prepare(
    "SELECT session_id FROM run_sessions WHERE run_id = ?"
  ).all(runId).map((row) => row.session_id)

  return {
    runId,
    ...counts,
    applied: rows.length - problems.length,
    pending: pendingCount(db, runId),
    distilled: markDistilled(db, sessionIds),
    source: cleanupFork(db, runId),
    problems
  }
}

export function reject(db, runId) {
  const run = requireRun(db, runId)
  const applied = db.prepare(
    "SELECT COUNT(*) AS n FROM staged WHERE run_id = ? AND applied_at IS NOT NULL"
  ).get(runId).n

  if (run.rejected_at) {
    return { runId, rejected: true, already: true, applied, source: cleanupFork(db, runId) }
  }
  if (applied > 0) {
    throw new Error(`dream run ${runId} has ${applied} applied proposal${applied === 1 ? "" : "s"}; cannot reject`)
  }

  const stamp = now()
  db.prepare("UPDATE dream_runs SET rejected_at = ?, finished_at = ? WHERE id = ?").run(stamp, stamp, runId)
  return { runId, rejected: true, applied: 0, rejected_at: stamp, source: cleanupFork(db, runId) }
}

function pendingCount(db, runId) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM staged WHERE run_id = ? AND applied_at IS NULL"
  ).get(runId).n
}

function requireRun(db, runId) {
  const run = db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(runId)
  if (!run) throw new Error(`dream run ${runId} not found`)
  return run
}

function applyOne(db, row, counts, runId) {
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
    const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id)
    if (!existing) throw new Error(`update target ${row.target_id} not found`)
    if (row.target_version !== null && row.target_version !== undefined && existing.version > row.target_version) {
      throw new Error(`stale candidate: note ${row.target_id} is at version ${existing.version}, candidate saw ${row.target_version}`)
    }
    const body = row.body.trim()
    if (existing.body !== body) recordRevision(db, existing, { runId, cause: "update" })
    db.prepare(`
      UPDATE notes SET body = ?, fingerprint = ?, confidence = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(body, fingerprint(body), row.confidence, now(), row.target_id)
    counts.updated += 1
    return
  }
  if (row.op === "retire") {
    if (!row.target_id) throw new Error("retire requires target_id")
    const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id)
    if (!existing) throw new Error(`retire target ${row.target_id} not found`)
    if (row.target_version !== null && row.target_version !== undefined && existing.version > row.target_version) {
      throw new Error(`stale candidate: note ${row.target_id} is at version ${existing.version}, candidate saw ${row.target_version}`)
    }
    db.prepare("UPDATE notes SET retired_at = ? WHERE id = ?").run(now(), row.target_id)
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
