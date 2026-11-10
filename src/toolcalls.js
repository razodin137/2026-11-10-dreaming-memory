import { now } from "./db.js"

export function record(db, { sessionId, command, output = "", exitCode = null, projectId = null, at = now() }) {
  if (!sessionId) throw new Error("a tool call needs a session")
  const text = String(command || "").trim()
  if (!text) throw new Error("a tool call needs a command")
  let project = projectId
  if (project === null) {
    const session = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId)
    project = session ? session.project_id : null
  }
  const code = exitCode === null || exitCode === undefined ? null : Number(exitCode)
  const failed = code === null ? looksFailed(output) : code !== 0
  const signature = failed ? signatureFor(text, output) : null
  const result = db.prepare(`
    INSERT INTO tool_calls (session_id, project_id, command, output, exit_code, ok, error_signature, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, project, text, String(output || ""), code, failed ? 0 : 1, signature, at)
  return db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(Number(result.lastInsertRowid))
}

function looksFailed(output) {
  return /error|failed|cannot|not found|exception|stale|denied|enoent|econnrefused/i.test(String(output || ""))
}

export function ingest(db, { sessionId, events, projectId = null }) {
  const list = normalize(events)
  const recorded = [ ]
  const failed = [ ]
  let pending = null
  let index = 0

  for (const event of list) {
    index += 1
    if (!event || typeof event !== "object") continue

    if ((event.type === "tool_result" || event.type === "tool_output") && pending) {
      const row = record(db, {
        sessionId,
        command: pending,
        output: outputOf(event),
        exitCode: exitOf(event),
        projectId
      })
      recorded.push(row)
      if (!row.ok) failed.push(row)
      pending = null
      continue
    }

    if (Array.isArray(event.content)) {
      const nested = parseContent(event.content)
      const result = ingest(db, { sessionId, events: nested, projectId })
      recorded.push(...result.recorded)
      failed.push(...result.failed)
      continue
    }

    const command = commandOf(event)
    if (command && hasResult(event)) {
      const row = record(db, {
        sessionId,
        command,
        output: outputOf(event),
        exitCode: exitOf(event),
        projectId
      })
      recorded.push(row)
      if (!row.ok) failed.push(row)
      continue
    }

    if (event.type === "tool_use" || event.type === "tool_call") {
      pending = command
      continue
    }

    if (event.type === "tool_result" || event.type === "tool_output") {
      if (!pending) continue
      const row = record(db, {
        sessionId,
        command: pending,
        output: outputOf(event),
        exitCode: exitOf(event),
        projectId
      })
      recorded.push(row)
      if (!row.ok) failed.push(row)
      pending = null
      continue
    }

    if (command) pending = command
    void index
  }

  return { recorded, failed }
}

export function forSession(db, { sessionId, limit = 100 } = { }) {
  return db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id LIMIT ?").all(sessionId, limit)
}

export function failures(db, { sessionId = null, projectId = null, since = null, limit = 100 } = { }) {
  const clauses = [ "ok = 0" ]
  const params = [ ]
  if (sessionId !== null) {
    clauses.push("session_id = ?")
    params.push(sessionId)
  }
  if (projectId !== null) {
    clauses.push("(project_id = ? OR project_id IS NULL)")
    params.push(projectId)
  }
  if (since) {
    clauses.push("created_at >= ?")
    params.push(since)
  }
  params.push(limit)
  return db.prepare(`
    SELECT * FROM tool_calls WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?
  `).all(...params)
}

export function recurring(db, { projectId = null, since = null, minSessions = 2, limit = 50 } = { }) {
  const clauses = [ "ok = 0", "error_signature IS NOT NULL" ]
  const params = [ ]
  if (projectId !== null) {
    clauses.push("(project_id = ? OR project_id IS NULL)")
    params.push(projectId)
  }
  if (since) {
    clauses.push("created_at >= ?")
    params.push(since)
  }
  const rows = db.prepare(`
    SELECT command, error_signature, session_id, output, created_at
    FROM tool_calls WHERE ${clauses.join(" AND ")} ORDER BY id ASC
  `).all(...params)

  const groups = new Map()
  for (const row of rows) {
    const key = row.error_signature
    if (!groups.has(key)) {
      groups.set(key, {
        commands: new Set(),
        signature: row.error_signature,
        output: firstError(row.output) || row.output,
        sessions: new Set(),
        attempts: 0,
        last_seen: row.created_at
      })
    }
    const group = groups.get(key)
    group.commands.add(row.command)
    group.sessions.add(row.session_id)
    group.attempts += 1
    group.last_seen = row.created_at
  }

  return Array.from(groups.values())
    .map((group) => ({
      command: Array.from(group.commands)[0],
      commands: Array.from(group.commands),
      signature: group.signature,
      output: group.output,
      sessions: Array.from(group.sessions),
      count: group.sessions.size,
      attempts: group.attempts,
      last_seen: group.last_seen
    }))
    .filter((group) => group.count >= minSessions)
    .sort((a, b) => b.count - a.count || String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, limit)
}

export function transcript(db, sessionId) {
  const calls = forSession(db, { sessionId })
  return {
    calls,
    failures: calls.filter((call) => !call.ok),
    recurring: recurring(db, { minSessions: 2 }).filter((group) => group.sessions.includes(sessionId))
  }
}

function normalize(events) {
  if (!events) return [ ]
  if (typeof events === "string") {
    const text = events.trim()
    if (!text) return [ ]
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) return parsed
        return normalize(parsed)
      } catch {
        return text.split("\n").map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).filter(Boolean)
      }
    }
    return text.split("\n").map((line) => ({ command: line })).filter((event) => event.command)
  }
  if (Array.isArray(events)) return events
  if (Array.isArray(events.events)) return events.events
  if (Array.isArray(events.messages)) return events.messages
  if (Array.isArray(events.tool_calls)) return events.tool_calls
  if (Array.isArray(events.toolCalls)) return events.toolCalls
  return [ events ]
}

function parseContent(blocks) {
  const events = [ ]
  let pending = null
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    if (block.type === "tool_use") {
      pending = commandOf(block)
      events.push(block)
    } else if (block.type === "tool_result") {
      events.push({ ...block, command: pending })
      pending = null
    } else {
      events.push(block)
    }
  }
  return events
}

function commandOf(event) {
  if (!event) return null
  if (typeof event.command === "string") return event.command
  if (typeof event.cmd === "string") return event.cmd
  const input = event.input || event.arguments || event.args
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    if (typeof input.command === "string") return input.command
    if (typeof input.cmd === "string") return input.cmd
  }
  return null
}

function hasResult(event) {
  return event.output !== undefined || event.result !== undefined || event.exit_code !== undefined ||
    event.exitCode !== undefined || event.is_error !== undefined || event.ok !== undefined
}

function outputOf(event) {
  if (event.output !== undefined) return stringify(event.output)
  if (event.result !== undefined) return stringify(event.result)
  if (event.content !== undefined) return stringify(event.content)
  return ""
}

function stringify(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((block) => {
      if (typeof block === "string") return block
      if (block && typeof block.text === "string") return block.text
      return JSON.stringify(block)
    }).join("\n")
  }
  return JSON.stringify(value)
}

function exitOf(event) {
  if (event.exit_code !== undefined) return Number(event.exit_code)
  if (event.exitCode !== undefined) return Number(event.exitCode)
  if (event.is_error === true) return 1
  if (event.ok === false) return 1
  return 0
}

function signatureFor(command, output) {
  const error = firstError(output)
  const text = String(error || command).toLowerCase()
  return text
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\b\d+(?:\.\d+)*\b/g, "#")
    .replace(/\/[^\s:]+/g, "/path")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
}

function firstError(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /error|failed|cannot|not found|exception|stale|denied|enoent|econnrefused/i.test(line)) ||
    lines[0] ||
    ""
}
