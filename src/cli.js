import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DB, init } from "./db.js"
import { packet, stage, apply, formatReview, reject, review } from "./dream.js"
import { materialize } from "./materialize.js"
import { KINDS, SCOPES, decay, promote, recall, remember, revisions, stats } from "./notes.js"
import { archiveStale, byPath, list, register } from "./projects.js"
import { end, start, writeDiary } from "./sessions.js"

export function run(argv) {
  const { command, flags, rest } = parse(argv)
  const dbPath = flags.db || DEFAULT_DB
  const db = init(dbPath)
  const cwd = process.cwd()

  switch (command) {
    case "init":
      return print({ db: dbPath, ...stats(db) })

    case "register": {
      const project = register(db, rest[0] || cwd)
      return print(project)
    }

    case "projects":
      return print(list(db).map((project) => ({
        slug: project.slug,
        path: project.path,
        status: project.status,
        last_seen_at: project.last_seen_at
      })))

    case "session": {
      const action = rest[0]
      if (action === "start") {
        const id = flags.id || `session-${Date.now()}`
        const result = start(db, { id, dir: flags.path || cwd })
        return print({ ...result, session: result.session.id })
      }
      if (action === "end") return print(end(db, { id: require(flags.id, "--id"), diary: readText(flags.diary) }))
      if (action === "diary") return print(writeDiary(db, { id: require(flags.id, "--id"), text: textArg(flags, rest) }))
      throw new Error("usage: mem session start|end|diary")
    }

    case "remember": {
      const project = register(db, flags.path || cwd)
      const result = remember(db, {
        projectId: project.id,
        scope: flags.scope || "project",
        kind: flags.kind || "fact",
        body: textArg(flags, rest),
        confidence: flags.confidence === undefined ? 0.6 : Number(flags.confidence),
        provenance: flags.provenance || project.slug
      })
      return print({ ...result, scope: flags.scope || "project", project: project.slug })
    }

    case "recall": {
      const project = byPath(db, flags.path || cwd)
      const notes = recall(db, {
        projectId: project ? project.id : null,
        limit: flags.limit ? Number(flags.limit) : 12,
        query: flags.query || null
      })
      return print(notes.map((note) => ({
        id: note.id,
        scope: note.scope,
        kind: note.kind,
        body: note.body,
        confidence: Number(note.confidence.toFixed(2)),
        score: Number(note.score.toFixed(3))
      })))
    }

    case "dream": {
      if (rest[0] === "stage") {
        return print(stage(db, { candidates: readCandidates(rest[1]), since: flags.since || null }))
      }
      if (rest[0] === "review") {
        const report = review(db, Number(require(rest[1], "RUN")))
        if (flags.json) return print(report)
        process.stdout.write(`${formatReview(report)}\n`)
        return report
      }
      if (rest[0] === "apply") {
        return print(apply(db, Number(require(rest[1], "RUN"))))
      }
      if (rest[0] === "reject") {
        return print(reject(db, Number(require(rest[1], "RUN"))))
      }
      if (flags.packet) {
        const project = flags.path ? byPath(db, flags.path) : byPath(db, cwd)
        return print(packet(db, {
          projectId: project ? project.id : null,
          since: flags.since || new Date(Date.now() - 86400000).toISOString()
        }))
      }
      if (flags.apply) {
        const staged = stage(db, { candidates: readCandidates(flags.apply), since: flags.since || null })
        const applied = apply(db, staged.runId)
        return print({ ...staged, ...applied })
      }
      if (flags.auto) {
        const promotion = promote(db)
        const pruning = decay(db, { archiveDays: flags.archiveDays ? Number(flags.archiveDays) : 30 })
        const archived = archiveStale(db, flags.archiveDays ? Number(flags.archiveDays) : 30)
        return print({ ...promotion, ...pruning, archived })
      }
      throw new Error("usage: mem dream --packet | stage FILE | review RUN | apply RUN | reject RUN | --apply FILE | --auto")
    }

    case "promote":
      return print(promote(db))

    case "decay":
      return print(decay(db, { archiveDays: flags.archiveDays ? Number(flags.archiveDays) : 30 }))

    case "materialize": {
      const project = flags.path ? register(db, flags.path) : byPath(db, cwd) || register(db, cwd)
      return print(materialize(db, { project }))
    }

    case "stats":
      return print(stats(db))

    case "revisions": {
      return print(revisions(db, {
        noteId: flags.note === undefined ? null : Number(flags.note),
        runId: flags.run === undefined ? null : Number(flags.run),
        limit: flags.limit ? Number(flags.limit) : 50
      }))
    }

    case "kinds":
      return print({ kinds: KINDS, scopes: SCOPES })

    default:
      throw new Error(`unknown command: ${command || "(none)"}\n${usage()}`)
  }
}

function parse(argv) {
  const flags = { }
  const rest = [ ]
  let command = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) flags[key] = true
      else {
        flags[key] = next
        index += 1
      }
      continue
    }
    if (command === null) command = arg
    else rest.push(arg)
  }
  return { command, flags, rest }
}

function textArg(flags, rest) {
  const value = flags.body || rest.join(" ") || readStdin()
  if (!value) throw new Error("no body given (pass --body, positionally, or on stdin)")
  return value.trim()
}

function readCandidates(source) {
  const parsed = JSON.parse(readText(require(source, "candidates FILE")))
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates
  if (!Array.isArray(candidates)) {
    throw new Error("candidates must be a JSON array or an object with a candidates array")
  }
  return candidates
}

function readText(source) {
  if (!source || source === true) return null
  return fs.readFileSync(path.resolve(source), "utf8")
}

function readStdin() {
  if (process.stdin.isTTY) return null
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return null
  }
}

function require(value, name) {
  if (value === undefined || value === true) throw new Error(`missing ${name}`)
  return value
}

function usage() {
  return [
    "mem init",
    "mem register [path]",
    "mem projects",
    "mem session start|end|diary [--id ID] [--diary FILE]",
    "mem remember --body TEXT [--kind gotcha] [--scope project] [--confidence 0.6]",
    "mem recall [--query TEXT] [--limit 12]",
    "mem dream --packet | stage FILE | review RUN [--json] | apply RUN | reject RUN | --apply FILE | --auto",
    "mem revisions [--note ID] [--run RUN] [--limit 50]",
    "mem promote | decay | materialize | stats"
  ].join("\n")
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return value
}
