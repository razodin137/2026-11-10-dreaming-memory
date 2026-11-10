import { now } from "./db.js"
import { liveNotes } from "./notes.js"
import { byId } from "./projects.js"
import { significant } from "./text.js"
import { projectionEnabled, syncTopics } from "./topics.js"

const COMMAND = new Set([ "npm", "pnpm", "yarn", "npx", "node", "bun", "git", "make", "bundle", "rake", "rails", "bin/rails", "docker" ])

export function enrich(db, { projectId = null, since = null, limit = 200, projection = projectionEnabled() } = { }) {
  const project = projectId === null ? null : byId(db, projectId)
  const stamp = now()
  const cutoff = since || new Date(Date.now() - 86400000).toISOString()
  const sessions = db.prepare(`
    SELECT s.id, s.project_id, s.diary, s.started_at FROM sessions s
    WHERE ((s.diary IS NOT NULL AND s.diary <> '') OR EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = s.id))
      AND s.started_at >= ?
      AND (? IS NULL OR s.project_id = ? OR s.project_id IS NULL)
    ORDER BY s.started_at ASC
  `).all(cutoff, project ? project.id : null, project ? project.id : null)
  if (sessions.length === 0) return { sessions: 0, notes: 0, enriched: 0 }

  const calls = new Map()
  for (const session of sessions) {
    calls.set(session.id, db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id").all(session.id))
  }
  const notes = liveNotes(db, { projectId: project ? project.id : null, limit })
  let enriched = 0

  for (const note of notes) {
    const matches = sessions.filter((session) => {
      return matchesText(note, session.diary) || matchesText(note, callText(calls.get(session.id)))
    })
    if (matches.length === 0) continue

    const provenance = mergeProvenance(note.provenance, matches.map((session) => session.id))
    const examples = mergeExamples(decode(note.examples), matches, note, calls)
    const prevalence = `${matches.length} of ${sessions.length} sessions`
    const repro = note.repro || bestCommand(note, matches, calls)

    const changed = provenance !== (note.provenance || "") ||
      prevalence !== (note.prevalence || "") ||
      JSON.stringify(examples) !== JSON.stringify(decode(note.examples) || null) ||
      (repro && repro !== note.repro)
    if (!changed) continue

    db.prepare(`
      UPDATE notes SET provenance = ?, examples = ?, prevalence = ?, repro = COALESCE(?, repro), enriched_at = ?
      WHERE id = ?
    `).run(provenance, JSON.stringify(examples), prevalence, repro, stamp, note.id)
    enriched += 1
  }

  const files = project && projection ? syncTopics(db, project) : null
  return { sessions: sessions.length, notes: notes.length, enriched, files }
}

function matchesText(note, text) {
  const body = new Set(significant(note.body))
  if (body.size === 0) return false
  const seen = new Set(significant(text))
  let shared = 0
  for (const token of body) {
    if (seen.has(token)) shared += 1
  }
  return shared >= (body.size <= 3 ? 1 : 2)
}

function callText(calls) {
  return (calls || [ ]).map((call) => `${call.command}\n${call.output || ""}`).join("\n")
}

function mergeProvenance(existing, ids) {
  const known = new Set(String(existing || "").split(" | ").filter(Boolean))
  for (const id of ids) known.add(id)
  return Array.from(known).join(" | ")
}

function mergeExamples(existing, sessions, note, calls) {
  const merged = new Map()
  for (const example of list(existing)) {
    merged.set(key(example), example)
  }
  for (const session of sessions) {
    const tool = (calls.get(session.id) || [ ]).find((call) => matchesText(note, `${call.command} ${call.output || ""}`))
    const excerpt = tool
      ? `${tool.command}: ${errorLine(tool.output)}`.slice(0, 200)
      : excerptFor(session.diary, note.body)
    const example = { session: session.id, excerpt }
    merged.set(key(example), example)
  }
  return Array.from(merged.values()).slice(0, 8)
}

function errorLine(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /error|failed|cannot|not found|exception|stale|denied/i.test(line)) || lines[0] || ""
}

function key(example) {
  if (typeof example === "string") return example
  return `${example?.session || ""}|${example?.excerpt || ""}`
}

function list(value) {
  if (!value) return [ ]
  if (Array.isArray(value)) return value
  return [ value ]
}

function excerptFor(diary, body) {
  const wanted = new Set(significant(body))
  const text = String(diary || "")
  const line = text.split("\n").find((entry) => {
    const words = significant(entry)
    return words.some((word) => wanted.has(word))
  }) || text
  return line.trim().slice(0, 160)
}

function bestCommand(note, sessions, calls) {
  const wanted = new Set(significant(note.body))
  let best = null
  for (const session of sessions) {
    for (const call of calls.get(session.id) || [ ]) {
      if (!looksLikeCommand(call.command)) continue
      const score = significant(`${call.command} ${call.output || ""}`).filter((token) => wanted.has(token)).length
      if (!best || score > best.score) best = { command: call.command, score }
    }
    const diary = String(session.diary || "")
    for (const match of diary.matchAll(/`([^`]+)`/g)) {
      const command = match[1].trim()
      if (!looksLikeCommand(command)) continue
      const line = lineAt(diary, match.index)
      const score = significant(line).filter((token) => wanted.has(token)).length
      if (!best || score > best.score) best = { command, score }
    }
  }
  return best ? `\`${best.command}\`` : null
}

function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1
  const end = text.indexOf("\n", index)
  return text.slice(start, end === -1 ? text.length : end)
}

function looksLikeCommand(value) {
  if (!value || value.includes("`")) return false
  const first = value.split(/\s+/)[0]
  return COMMAND.has(first) || value.startsWith("bin/") || value.startsWith("./")
}

function decode(value) {
  if (!value) return null
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
