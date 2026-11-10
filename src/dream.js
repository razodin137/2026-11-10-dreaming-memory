import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fingerprint, now, open, transaction } from "./db.js"
import {
  KINDS, SCOPES, decodeExamples, encodeExamples, mergeExamples, mergeProvenance,
  normalizeTopic, promote as stagePromotions, recordRevision, remember, resolveExistingTopic
} from "./notes.js"
import { byId, bySlug, resolve as resolveProject } from "./projects.js"
import { markDistilled, undistilled } from "./sessions.js"
import { projectionEnabled, INDEX, files, readTopic, syncTopics } from "./topics.js"
import { clearer, sameClaim, similarity } from "./text.js"
import { topicKey } from "./subjects.js"
import { dropper, read as readSteering } from "./steering.js"
import { forSession as toolCallsFor, failures as toolFailures, recurring as toolRecurring } from "./toolcalls.js"

export const CANDIDATE_SCHEMA = {
  op: "insert | merge | update | retire",
  project: "project slug (omit for global)",
  scope: "project | global",
  topic: "subject a future agent would search for, e.g. deploy, flaky-tests, repo-layout",
  kind: "fact | gotcha | convention | decision",
  body: "checkable claim: a path, command, version, or specific gotcha",
  confidence: "0..1",
  provenance: "session id or file:line that this came from",
  session: "id of the session this candidate came from (required for dream collect)",
  sessions: "all session ids behind a repeated claim",
  target_id: "note id, required for update and retire; the note this proposal replaces",
  replaces: "note ids this proposal absorbs, so a merge names everything it replaces",
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
    group.files = project ? currentFiles(project) : [ ]
    group.steering = readSteering(project)
    group.tool_calls = group.diaries.flatMap((diary) => toolCallsFor(db, { sessionId: diary.session }))
    group.failures = project ? toolFailures(db, { projectId: project.id, limit: 40 }) : [ ]
    group.recurring = project ? toolRecurring(db, { projectId: project.id }) : [ ]
  }
  return {
    generated_at: now(),
    since,
    instructions: [
      "Synthesize the diaries and tool calls into a diff, not a pile of new notes.",
      "Read the current topic files in `files`; prefer merging into an existing note over adding a near-duplicate.",
      "Every body must be checkable: a path, a command, a version, or a specific gotcha.",
      "Read tool_calls, failures, and recurring: a command that failed and the error behind it outranks prose.",
      "Prefer one lesson from a repeated claim over one note per session; name what it replaces.",
      "Reject anything that only restates what the code already makes obvious.",
      "Set scope=global only for claims that hold across repositories; sessions cannot write global directly.",
      "Cite the session id or file:line in provenance.",
      "Set session to the id of the session each candidate came from so collect can attribute it.",
      "Set topic to the subject file this claim belongs in, e.g. deploy, flaky-tests, repo-layout.",
      "For every candidate, list examples ({ session, excerpt }), state its prevalence, and follow the steering file."
    ],
    candidate_schema: CANDIDATE_SCHEMA,
    projects: Array.from(groups.values()),
    sessions: scoped.map((session) => session.id)
  }
}

export function stage(db, { candidates, since, sessionId = null, sourceFork = null, sourcePath = null, steering = null }) {
  const problems = [ ]
  const skipped = [ ]
  let stagedCount = 0
  let runId = null

  transaction(db, () => {
    runId = Number(db.prepare(
      "INSERT INTO dream_runs (started_at, source_fork, source_path) VALUES (?, ?, ?)"
    ).run(now(), sourceFork, sourcePath).lastInsertRowid)
    const insert = db.prepare(`
      INSERT INTO staged (run_id, op, verb, project_slug, scope, topic, kind, body, confidence, provenance, target_id, target_version, reason, examples, prevalence, replaces, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const [ index, candidate ] of candidates.entries()) {
      const error = validate(candidate)
      if (error) {
        problems.push({ index, error })
        continue
      }
      const owner = candidate.session_id || candidate.session || sessionId || null
      const scope = candidate.scope || "project"
      const project = resolveCandidateProject(db, candidate, owner)
      const needsProject = candidate.op === "insert" || candidate.op === "merge" || candidate.op === "update"
      if (needsProject && scope === "project" && !project) {
        problems.push({ index, error: "project note has no project" })
        continue
      }
      const steer = typeof steering === "function"
        ? steering
        : steering && typeof steering.drops === "function"
          ? steering.drops
          : dropper(project)
      if (steer(candidate.body)) {
        skipped.push({ index, reason: "steering: this claim is not worth remembering" })
        continue
      }
      insert.run(
        runId,
        candidate.op,
        candidate.verb || null,
        project ? project.slug : null,
        scope,
        candidate.topic ? normalizeTopic(candidate.topic) : null,
        candidate.kind || "fact",
        candidate.body || "",
        clamp(candidate.confidence ?? 0.5),
        candidate.provenance || "",
        candidate.target_id || null,
        candidate.target_version ?? null,
        candidate.reason || null,
        encodeExamples(candidate.examples),
        candidate.prevalence ? String(candidate.prevalence) : null,
        encodeExamples(candidate.replaces),
        owner
      )
      stagedCount += 1
      const owners = candidate.sessions || [ owner ]
      for (const session of owners) {
        if (!session) continue
        db.prepare("INSERT OR IGNORE INTO run_sessions (run_id, session_id) VALUES (?, ?)").run(runId, session)
      }
    }
  })

  return { runId, staged: stagedCount, problems, skipped, since }
}

export function resolveCandidateProject(db, candidate, sessionId = null) {
  if (candidate.op === "update" || candidate.op === "retire" || candidate.op === "promote") {
    if (candidate.target_id) {
      const note = db.prepare("SELECT project_id FROM notes WHERE id = ?").get(candidate.target_id)
      if (note && note.project_id) return byId(db, note.project_id)
    }
  }
  if (candidate.project) {
    const resolved = resolveProject(db, candidate.project)
    if (resolved) return resolved
  }
  if (sessionId) {
    const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId)
    if (session && session.project_id) return byId(db, session.project_id)
  }
  return null
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
        "Synthesize this one session, including its tool calls and their output, into a diff.",
        "Read the current topic files in `files`; prefer merging into an existing note over adding a near-duplicate.",
        "A failed command and the error it printed outrank a description of the same problem.",
        "Every body must be checkable: a path, a command, a version, or a specific gotcha.",
        "Reject anything that only restates what the code already makes obvious.",
        "Set scope=global only for claims that hold across repositories; sessions cannot write global directly.",
        "Set topic to the subject file this claim belongs in, e.g. deploy, flaky-tests, repo-layout.",
        "Set session to this session id so collect can attribute every candidate.",
        "Follow the steering file: keep what cost a session time, drop scratch and trivia."
      ],
      candidate_schema: CANDIDATE_SCHEMA,
      steering: readSteering(project),
      diary: session.diary,
      tool_calls: toolCallsFor(db, { sessionId: session.id }),
      failures: toolFailures(db, { sessionId: session.id }),
      notes: existingNotes(db, project ? project.id : -1, limit),
      files: project ? currentFiles(project) : [ ]
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
    const planned = consolidate(db, reduced.proposals)
    const staged = stage(db, {
      candidates: planned.proposals,
      since: null,
      sourceFork: forkId,
      sourcePath: source
    })

    return {
      ...staged,
      already: false,
      skipped: reduced.skipped.length + planned.skipped.length,
      superseded: reduced.superseded.length,
      skipped_rows: [ ...reduced.skipped, ...planned.skipped ],
      superseded_rows: reduced.superseded,
      merged: planned.merged
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
      verb: row.verb || null,
      project: row.project_slug || null,
      scope: row.scope,
      topic: row.topic || null,
      kind: row.kind,
      body: row.body,
      confidence: Number(row.confidence),
      provenance: row.provenance || null,
      target_id: row.target_id || null,
      target_version: row.target_version ?? null,
      replaces: decodeExamples(row.replaces) || null,
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
    let prior = byFact.get(key)
    if (!prior) {
      for (const item of byFact.values()) {
        if (sameGroup(item, candidate) && sameClaim(item.body, candidate.body)) {
          prior = item
          break
        }
      }
    }
    if (prior) mergeCandidate(prior, candidate)
    else {
      proposals.push(candidate)
      byFact.set(key, candidate)
    }
  }

  return { proposals, skipped, superseded }
}

function sameGroup(left, right) {
  if (left.scope !== right.scope) return false
  if ((left.project || null) !== (right.project || null)) return false
  if (left.kind !== right.kind) return false
  return topicKey(left.topic || "general") === topicKey(right.topic || "general")
}

function mergeCandidate(into, from) {
  if (clearer(from.body, into.body)) into.body = from.body
  into.confidence = Math.max(into.confidence, from.confidence)
  into.provenance = mergeText(into.provenance, from.provenance)
  into.examples = mergeExamples(into.examples, from.examples)
  into.prevalence = from.prevalence || into.prevalence
  into.reason = from.reason || into.reason
  into.topic = from.topic || into.topic
  into.replaces = Array.from(new Set([ ...asList(into.replaces), ...asList(from.replaces) ]))
  into.session = from.session
  into.sessions = Array.from(new Set([ ...into.sessions, ...from.sessions ]))
}

function asList(value) {
  if (!value) return [ ]
  return Array.isArray(value) ? value : [ value ]
}

export function consolidate(db, proposals) {
  const groups = [ ]
  const output = [ ]
  const skipped = [ ]
  let merged = 0

  for (const candidate of proposals) {
    if (candidate.op !== "insert" && candidate.op !== "merge") {
      output.push(candidate)
      continue
    }
    const project = resolveCandidateProject(db, candidate, candidate.session)
    const scope = candidate.scope || "project"
    const subject = candidate.topic
      ? resolveExistingTopic(db, { projectId: project ? project.id : null, scope, requested: candidate.topic })
      : null
    const prepared = { ...candidate, project: project ? project.slug : null, scope, topic: subject }

    const prior = groups.find((item) => sameGroup(item, prepared) && sameClaim(item.body, prepared.body))
    if (prior) {
      mergeCandidate(prior, prepared)
      merged += 1
    } else {
      groups.push(prepared)
    }
  }

  for (const group of groups) {
    const matches = existingClaims(db, group)
    if (matches.length > 0) {
      const target = pickTarget(matches, group)
      group.op = "merge"
      group.target_id = target.id
      group.target_version = target.version
      group.replaces = Array.from(new Set([
        ...asList(group.replaces),
        ...matches.filter((note) => note.id !== target.id).map((note) => note.id)
      ]))
      group.prevalence = group.prevalence || prevalenceFor(group.sessions)
      group.reason = group.reason || `consolidates ${matches.length} existing note${matches.length === 1 ? "" : "s"}`
    } else {
      group.op = "insert"
      group.prevalence = group.prevalence || prevalenceFor(group.sessions)
    }
    output.push(group)
  }

  return { proposals: output, skipped, merged }
}

export function proposePromotions(db) {
  return stagePromotions(db)
}

function existingClaims(db, group) {
  const projectId = group.scope === "global" ? 0 : projectIdFor(db, group.project)
  const clauses = [
    "retired_at IS NULL",
    "scope = ?",
    "IFNULL(project_id, 0) = ?",
    "kind = ?"
  ]
  const params = [ group.scope, projectId, group.kind ]
  if (group.topic) {
    clauses.push("topic = ?")
    params.push(group.topic)
  }
  const rows = db.prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")}`).all(...params)
  return rows.filter((note) => fingerprint(note.body) === fingerprint(group.body) || sameClaim(note.body, group.body))
}

function projectIdFor(db, slug) {
  if (!slug) return 0
  const project = bySlug(db, slug)
  return project ? project.id : 0
}

function pickTarget(matches, group) {
  return matches
    .slice()
    .sort((a, b) => {
      const body = similarity(group.body, a.body) - similarity(group.body, b.body)
      if (body !== 0) return body
      return Number(b.confidence) - Number(a.confidence) || a.id - b.id
    })[0]
}

function prevalenceFor(sessions) {
  const count = Array.from(new Set(sessions || [ ])).length
  return `seen in ${count} session${count === 1 ? "" : "s"}`
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

export function currentFiles(project) {
  return files(project)
    .filter((file) => path.basename(file) !== INDEX)
    .map((file) => ({
      path: file,
      ...readTopic(file)
    }))
}

function existingNotes(db, projectId, limit = 40) {
  return db.prepare(`
    SELECT id, kind, topic, body, confidence, hits FROM notes
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

export function review(db, runId) {
  const run = requireRun(db, runId)
  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? ORDER BY id").all(runId)
  const applied = rows.filter((row) => row.applied_at).length
  return {
    runId: Number(runId),
    started_at: run.started_at,
    finished_at: run.finished_at,
    rejected_at: run.rejected_at || null,
    reverted_at: run.reverted_at || null,
    proposals: rows.length,
    applied,
    pending: rows.length - applied,
    changes: rows.map((row) => describe(db, row))
  }
}

export function formatReview(report) {
  const count = `${report.proposals} proposal${report.proposals === 1 ? "" : "s"}`
  let status = "not applied"
  if (report.reverted_at) status = "reverted"
  else if (report.rejected_at) status = "rejected"
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
  const verb = change.verb ? `${change.verb}: ` : ""
  const subject = change.topic && change.topic !== "general" ? `${change.project} / ${change.topic} / ${change.kind}` : `${change.project} / ${change.kind}`
  const lines = [
    `${index}. ${verb}${change.op}  ${subject}  confidence ${confidence}${target}${marker}`
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

  if (change.replaces && change.replaces.length > 0) {
    lines.push(field("replaces:", change.replaces.map((id) => `#${id}`).join(", ")))
  }
  lines.push(field("evidence:", formatExamples(change.examples) || "(none)"))
  lines.push(field("prevalence:", change.prevalence || "(not given)"))
  if (change.provenance) lines.push(field("provenance:", change.provenance))
  if (change.reason) lines.push(field("reason:", change.reason))

  return lines
}

function describe(db, row) {
  const targetNote = row.target_id ? db.prepare("SELECT project_id FROM notes WHERE id = ?").get(row.target_id) : null
  const targetProject = targetNote && targetNote.project_id ? byId(db, targetNote.project_id) : null
  const project = row.project_slug ? bySlug(db, row.project_slug) : targetProject
  return {
    id: row.id,
    op: row.op,
    verb: row.verb || null,
    project: project ? project.slug : "global",
    scope: row.scope,
    topic: row.topic ? normalizeTopic(row.topic) : "general",
    kind: row.kind,
    body: row.body,
    confidence: Number(row.confidence),
    provenance: row.provenance || null,
    reason: row.reason || null,
    examples: decodeExamples(row.examples),
    prevalence: row.prevalence || null,
    replaces: asList(decodeExamples(row.replaces)),
    target: targetFor(db, row, project),
    applied_at: row.applied_at || null
  }
}

function targetFor(db, row, project) {
  if (row.op === "update" || row.op === "retire" || row.op === "merge" || row.op === "promote") {
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
    topic: note.topic || "general",
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
    verb: row.verb || null,
    project: row.project_slug || "global",
    topic: row.topic ? normalizeTopic(row.topic) : "general",
    body: row.body,
    confidence: Number(row.confidence),
    provenance: row.provenance || null,
    reason: row.reason || null,
    examples: decodeExamples(row.examples),
    prevalence: row.prevalence || null,
    replaces: asList(decodeExamples(row.replaces))
  }))
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

export function apply(db, runId, { projection = projectionEnabled() } = { }) {
  const run = requireRun(db, runId)
  if (run.rejected_at) throw new Error(`dream run ${runId} was rejected; nothing to apply`)

  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? AND applied_at IS NULL ORDER BY id").all(runId)
  const counts = { inserted: 0, merged: 0, retired: 0, updated: 0, promoted: 0 }
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
          promoted = promoted + ?,
          summary = ?
      WHERE id = ?
    `).run(
      pending === 0 ? now() : null,
      counts.inserted,
      counts.merged,
      counts.retired,
      counts.promoted,
      JSON.stringify({ problems, proposals: summarizeProposals(stagedRows) }),
      runId
    )
  })

  const sessionIds = db.prepare(
    "SELECT session_id FROM run_sessions WHERE run_id = ?"
  ).all(runId).map((row) => row.session_id)
  const touched = new Set(rows.map((row) => row.project_slug).filter(Boolean))
  if (rows.some((row) => !row.project_slug || row.scope === "global")) {
    for (const project of db.prepare("SELECT slug FROM projects").all()) touched.add(project.slug)
  }

  return {
    runId,
    ...counts,
    applied: rows.length - problems.length,
    pending: pendingCount(db, runId),
    distilled: markDistilled(db, sessionIds),
    source: cleanupFork(db, runId),
    files: projection ? Array.from(touched).map((slug) => {
      const project = bySlug(db, slug)
      return project ? syncTopics(db, project) : null
    }).filter(Boolean) : [ ],
    problems
  }
}

export function revert(db, runId, { projection = projectionEnabled() } = { }) {
  const run = requireRun(db, runId)
  if (run.reverted_at) return { runId, reverted: true, already: true, restored: 0, retired: 0, files: [ ] }

  const rows = db.prepare("SELECT * FROM staged WHERE run_id = ? AND applied_at IS NOT NULL").all(runId)
  if (rows.length === 0) throw new Error(`dream run ${runId} has nothing applied to revert`)

  const revisions = db.prepare("SELECT * FROM note_revisions WHERE run_id = ? ORDER BY id DESC").all(runId)
  const touched = new Set()
  for (const row of rows) {
    const project = row.project_slug ? bySlug(db, row.project_slug) : null
    if (project) touched.add(project.id)
  }
  const problems = [ ]
  const counts = { restored: 0, retired: 0 }
  const restoredIds = new Set(revisions.map((revision) => revision.note_id))
  const stamp = now()

  transaction(db, () => {
    for (const revision of revisions) {
      const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(revision.note_id)
      if (!note) continue
      try {
        recordRevision(db, note, { runId, cause: "revert", reason: `reverting run ${runId}` })
        db.prepare(`
          UPDATE notes SET body = ?, fingerprint = ?, scope = ?, topic = ?, kind = ?, confidence = ?,
            provenance = ?, retired_at = ?, verify_result = NULL, updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(
          revision.body,
          revision.fingerprint,
          revision.scope,
          revision.topic || "general",
          revision.kind,
          revision.confidence,
          revision.provenance,
          revision.retired_at,
          revision.updated_at,
          revision.note_id
        )
        counts.restored += 1
        if (revision.project_id) touched.add(revision.project_id)
      } catch (error) {
        problems.push({ note_id: revision.note_id, error: error.message })
      }
    }

    for (const row of rows) {
      if (row.op !== "insert") continue
      const project = row.project_slug ? bySlug(db, row.project_slug) : null
      const projectId = row.scope === "global" ? 0 : project ? project.id : 0
      const note = db.prepare(`
        SELECT * FROM notes
        WHERE scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND fingerprint = ? AND retired_at IS NULL
      `).get(row.scope, projectId, row.kind, fingerprint(row.body))
      if (!note || note.created_at < run.started_at || restoredIds.has(note.id)) continue
      recordRevision(db, note, { runId, cause: "revert", reason: `reverting run ${runId}` })
      db.prepare("UPDATE notes SET retired_at = ?, version = version + 1 WHERE id = ?").run(stamp, note.id)
      counts.retired += 1
      if (project) touched.add(project.id)
    }

    db.prepare("UPDATE dream_runs SET reverted_at = ? WHERE id = ?").run(stamp, runId)
  })

  const files = projection ? Array.from(touched).map((projectId) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId)
    return project ? syncTopics(db, project) : null
  }).filter(Boolean) : [ ]

  return { runId, reverted: true, ...counts, problems, files }
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
  if (row.op === "promote") {
    applyPromotion(db, row, counts, runId, project)
    return
  }
  if (row.op === "insert" || row.op === "merge") {
    if (row.scope === "project" && !project) throw new Error("project note has no project")
    if (row.op === "merge" && row.target_id) {
      mergeInto(db, row, counts, runId)
      return
    }
    const result = remember(db, {
      projectId: project ? project.id : null,
      scope: row.scope,
      topic: row.topic || null,
      kind: row.kind,
      body: row.body,
      confidence: row.confidence,
      provenance: row.provenance,
      examples: decodeExamples(row.examples),
      prevalence: row.prevalence
    }, { allowGlobal: true })
    if (result.created) counts.inserted += 1
    else counts.merged += 1
    retireReplaces(db, row, runId, result.id)
    return
  }
  if (row.op === "update") {
    if (!row.target_id) throw new Error("update requires target_id")
    const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id)
    if (!existing) throw new Error(`update target ${row.target_id} not found`)
    checkStale(existing, row)
    const body = row.body.trim()
    const topic = row.topic
      ? (row.verb === "organize" ? normalizeTopic(row.topic) : resolveExistingTopic(db, {
        projectId: existing.project_id,
        scope: existing.scope,
        requested: row.topic
      }))
      : existing.topic
    if (existing.body !== body || existing.topic !== topic) {
      recordRevision(db, existing, { runId, cause: "update", reason: row.reason || null })
    }
    const provenance = mergeProvenance(existing.provenance, row.provenance)
    const examples = encodeExamples(mergeExamples(decodeExamples(existing.examples), decodeExamples(row.examples)))
    const changed = existing.body !== body ||
      Number(existing.confidence) !== Number(row.confidence) ||
      existing.topic !== topic
    const updatedAt = changed ? now() : existing.updated_at
    db.prepare(`
      UPDATE notes SET body = ?, fingerprint = ?, confidence = ?, topic = ?, provenance = ?,
        examples = COALESCE(?, examples), prevalence = COALESCE(?, prevalence),
        updated_at = ?, verify_result = NULL, version = version + 1
      WHERE id = ?
    `).run(body, fingerprint(body), row.confidence, topic, provenance, examples, row.prevalence, updatedAt, row.target_id)
    retireReplaces(db, row, runId, row.target_id)
    counts.updated += 1
    return
  }
  if (row.op === "retire") {
    if (!row.target_id) throw new Error("retire requires target_id")
    const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id)
    if (!existing) throw new Error(`retire target ${row.target_id} not found`)
    checkStale(existing, row)
    recordRevision(db, existing, { runId, cause: "update", reason: row.reason || "retired" })
    db.prepare("UPDATE notes SET retired_at = ?, version = version + 1 WHERE id = ?").run(now(), row.target_id)
    counts.retired += 1
    return
  }
  throw new Error(`unknown op: ${row.op}`)
}

function checkStale(existing, row) {
  if (row.target_version !== null && row.target_version !== undefined && existing.version > row.target_version) {
    throw new Error(`stale candidate: note ${existing.id} is at version ${existing.version}, candidate saw ${row.target_version}`)
  }
}

function mergeInto(db, row, counts, runId) {
  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.target_id)
  if (!existing) throw new Error(`merge target ${row.target_id} not found`)
  checkStale(existing, row)
  let body = clearer(row.body, existing.body) ? row.body.trim() : existing.body
  const clash = db.prepare(`
    SELECT * FROM notes
    WHERE id <> ? AND retired_at IS NULL AND scope = ? AND IFNULL(project_id, 0) = ? AND kind = ? AND fingerprint = ?
  `).get(existing.id, existing.scope, existing.project_id ?? 0, existing.kind, fingerprint(body))
  if (clash) body = existing.body

  const topic = row.topic
    ? resolveExistingTopic(db, {
      projectId: existing.project_id,
      scope: existing.scope,
      requested: row.topic
    })
    : existing.topic
  if (body !== existing.body || topic !== existing.topic) {
    recordRevision(db, existing, { runId, cause: "update", reason: row.reason || "consolidated duplicate" })
  }
  const confidence = clamp(Math.max(Number(existing.confidence), Number(row.confidence)) + 0.05)
  const provenance = mergeProvenance(existing.provenance, row.provenance)
  const examples = encodeExamples(mergeExamples(decodeExamples(existing.examples), decodeExamples(row.examples)))
  db.prepare(`
    UPDATE notes SET body = ?, fingerprint = ?, confidence = ?, topic = ?, provenance = ?,
      examples = COALESCE(?, examples), prevalence = COALESCE(?, prevalence),
      updated_at = ?, verify_result = NULL, version = version + 1
    WHERE id = ?
  `).run(body, fingerprint(body), confidence, topic, provenance, examples, row.prevalence, now(), existing.id)
  retireReplaces(db, row, runId, existing.id)
  counts.merged += 1
}

function retireReplaces(db, row, runId, keepId) {
  const ids = asList(decodeExamples(row.replaces)).map(Number).filter((id) => id && id !== keepId)
  if (ids.length === 0) return
  const keep = db.prepare("SELECT * FROM notes WHERE id = ?").get(keepId)
  if (!keep) return
  let provenance = keep.provenance
  let examples = decodeExamples(keep.examples)
  for (const id of ids) {
    const note = db.prepare("SELECT * FROM notes WHERE id = ? AND retired_at IS NULL").get(id)
    if (!note) continue
    provenance = mergeProvenance(provenance, note.provenance)
    examples = mergeExamples(examples, decodeExamples(note.examples))
    recordRevision(db, note, { runId, cause: "update", reason: `merged into note ${keepId}` })
    db.prepare("UPDATE notes SET retired_at = ?, version = version + 1 WHERE id = ?").run(now(), id)
  }
  db.prepare("UPDATE notes SET provenance = ?, examples = ? WHERE id = ?")
    .run(provenance, encodeExamples(examples), keepId)
}

function applyPromotion(db, row, counts, runId, project) {
  const ids = Array.from(new Set([ row.target_id, ...asList(decodeExamples(row.replaces)) ].map(Number).filter(Boolean)))
  const copies = ids.map((id) => db.prepare("SELECT * FROM notes WHERE id = ? AND retired_at IS NULL").get(id)).filter(Boolean)
  if (copies.length < 1) throw new Error("promote has no live source note")
  const source = copies.reduce((best, copy) => (Number(copy.confidence) > Number(best.confidence) ? copy : best), copies[0])
  const body = row.body || source.body
  const kind = row.kind || source.kind
  const topic = resolveExistingTopic(db, { projectId: null, scope: "global", requested: row.topic || source.topic })
  const existing = db.prepare(
    "SELECT * FROM notes WHERE scope = 'global' AND kind = ? AND fingerprint = ? AND retired_at IS NULL"
  ).get(kind, fingerprint(body))

  if (existing) {
    db.prepare(`
      UPDATE notes SET confidence = ?, provenance = ?, topic = ?, examples = COALESCE(?, examples),
        updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(
      clamp(Math.max(Number(existing.confidence), Number(source.confidence)) + 0.1),
      mergeProvenance(existing.provenance, copies.map((copy) => copy.provenance).join(" | ")),
      topic,
      encodeExamples(mergeExamples(decodeExamples(existing.examples), copies.flatMap((copy) => asList(decodeExamples(copy.examples))))),
      now(),
      existing.id
    )
  } else {
    const result = db.prepare(`
      INSERT INTO notes (project_id, scope, topic, kind, body, fingerprint, confidence, hits, provenance, version, created_at, updated_at)
      VALUES (NULL, 'global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      topic,
      kind,
      body,
      fingerprint(body),
      clamp(Number(source.confidence) + 0.1),
      Number(source.hits || 0),
      copies.map((copy) => copy.provenance).filter(Boolean).join(" | "),
      Math.max(...copies.map((copy) => copy.version)) + 1,
      now(),
      now()
    )
    recordRevision(db, {
      ...source,
      id: Number(result.lastInsertRowid),
      version: Math.max(...copies.map((copy) => copy.version))
    }, {
      runId,
      cause: "promote"
    })
  }

  const stamp = now()
  for (const copy of copies) {
    db.prepare("UPDATE notes SET retired_at = ?, version = version + 1 WHERE id = ?").run(stamp, copy.id)
  }
  counts.promoted += 1
  void project
}

function validate(candidate) {
  if (!candidate || typeof candidate !== "object") return "candidate must be an object"
  if (![ "insert", "merge", "update", "retire", "promote" ].includes(candidate.op)) return `bad op: ${candidate.op}`
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
