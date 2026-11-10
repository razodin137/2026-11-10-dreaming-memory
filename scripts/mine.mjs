import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const DB = process.env.OPENCODE_DB || path.join(process.env.HOME, ".local/share/opencode/opencode.db")
const [ command, ...args ] = process.argv.slice(2)

if (command === "list") list(args)
else if (command === "merge") merge(args)
else if (command === "salvage") salvage(args)
else {
  process.stderr.write("usage: mine.mjs list [MIN_MESSAGES] [LIMIT] [DAYS] | merge [DIR] [OUT] | salvage LOG TARGET\n")
  process.exit(1)
}

function list([ min = "6", limit = "0", days = "0", includeHome = "0", projects = "" ]) {
  const db = new DatabaseSync(DB, { readOnly: true })
  const clauses = [ "s.parent_id IS NULL", "s.time_archived IS NULL" ]
  const params = [ ]
  if (Number(days) > 0) {
    clauses.push("s.time_updated >= ?")
    params.push(Date.now() - Number(days) * 86400000)
  }
  if (includeHome !== "1") {
    clauses.push("COALESCE(p.worktree, s.directory) NOT IN ('/', ?)")
    params.push(process.env.HOME)
  }
  const wanted = projects.split(",").map((value) => value.trim()).filter(Boolean)
  if (wanted.length > 0) {
    clauses.push(`(${wanted.map(() => "COALESCE(p.worktree, s.directory) LIKE ?").join(" OR ")})`)
    for (const value of wanted) params.push(`%${value}%`)
  }
  const rows = db.prepare(`
    SELECT s.id, COALESCE(p.worktree, s.directory) AS directory, s.title,
      (SELECT COUNT(*) FROM session_message m
       WHERE m.session_id = s.id AND m.type IN ('user', 'assistant')) AS messages
    FROM session_v2 s
    LEFT JOIN project p ON p.id = s.project_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY s.time_updated DESC
  `).all(...params)

  const queue = rows
    .filter((row) => row.messages >= Number(min))
    .slice(0, Number(limit) > 0 ? Number(limit) : undefined)

  for (const row of queue) {
    console.log([ row.id, row.messages, row.directory || "", oneLine(row.title) ].join("\t"))
  }
}

function merge([ dir = ".scratch/memories", out = ".scratch/candidates.json" ]) {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort()
    : [ ]
  const candidates = [ ]
  let bad = 0
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
      const items = Array.isArray(parsed) ? parsed : parsed.candidates
      if (!Array.isArray(items)) throw new Error("not an array")
      candidates.push(...items)
    } catch (error) {
      bad += 1
      process.stderr.write(`skip ${file}: ${error.message}\n`)
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(candidates, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ files: files.length, bad, candidates: candidates.length, out }, null, 2)}\n`)
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function salvage([ log, target ]) {
  if (!log || !target) {
    process.stderr.write("usage: mine.mjs salvage LOG TARGET\n")
    process.exit(1)
  }
  const text = fs.readFileSync(log, "utf8")
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
  const loose = text.match(/\[[\s\S]*\]/)
  const body = fenced ? fenced[1] : loose ? loose[0] : null
  if (!body) {
    process.stderr.write("no JSON array in log\n")
    process.exit(1)
  }
  const items = JSON.parse(body)
  if (!Array.isArray(items)) {
    process.stderr.write("salvaged value is not an array\n")
    process.exit(1)
  }
  fs.writeFileSync(target, `${JSON.stringify(items, null, 2)}\n`)
  process.stdout.write(`${items.length}\n`)
}
