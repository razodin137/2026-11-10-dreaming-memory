import fs from "node:fs"
import path from "node:path"
import { DEFAULT_DB, init } from "./db.js"
import {
  packet, stage, apply, formatReview, reject, revert, review, fork, transcripts, propose, collect,
  consolidate, proposePromotions
} from "./dream.js"
import { add as draftAdd, commit as draftCommit, drop as draftDrop, list as draftList } from "./drafts.js"
import { enrich } from "./enrich.js"
import { materialize } from "./materialize.js"
import { KINDS, SCOPES, decay, recall, recordUse, revisions, stats } from "./notes.js"
import { organize } from "./organize.js"
import { archiveStale, byPath, list, register, resolve as resolveProject } from "./projects.js"
import { end, importSession, start, writeDiary } from "./sessions.js"
import { describe as steeringDescribe, ensure as steeringEnsure } from "./steering.js"
import {
  failures as failedToolCalls, ingest as ingestToolCalls, record as recordToolCall, recurring as recurringToolCalls
} from "./toolcalls.js"
import { recordNote, syncTopics, topicCounts } from "./topics.js"
import { verify } from "./verify.js"

export function run(argv) {
  const { command, flags, rest } = parse(argv)
  const dbPath = flags.db || DEFAULT_DB
  const db = init(dbPath)
  const cwd = process.cwd()
  const sessionId = flags.session || process.env.MEM_SESSION || null
  const projection = projectionFlag(flags)

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
        const id = flags.id || sessionId || `session-${Date.now()}`
        const result = start(db, {
          id,
          dir: flags.path || cwd,
          limit: flags.limit ? Number(flags.limit) : 12
        })
        return print({ ...result, session: result.session.id, project: result.project.slug })
      }
      if (action === "end") {
        const lessons = readLessons(flags.learn || flags.lessons)
        const result = end(db, {
          id: require(flags.id || sessionId, "--id"),
          diary: diaryArg(flags.diary),
          lessons,
          commit: flags["no-commit"] ? false : true
        })
        return print(result)
      }
      if (action === "diary") {
        return print(writeDiary(db, { id: require(flags.id || sessionId, "--id"), text: textArg(flags, rest) }))
      }
      if (action === "import") {
        const id = require(flags.id || sessionId, "--id")
        const imported = importSession(db, {
          id,
          dir: flags.path || cwd,
          project: flags.project ? (resolveProject(db, flags.project) || register(db, flags.project)) : null,
          startedAt: flags["started-at"] || flags.startedAt || null,
          endedAt: flags["ended-at"] || flags.endedAt || null,
          diary: diaryArg(flags.diary)
        })
        if (flags.transcript) {
          ingestToolCalls(db, { sessionId: id, events: readText(flags.transcript) })
        }
        return print(imported)
      }
      if (action === "tool") {
        return print(recordToolCall(db, {
          sessionId: require(flags.id || sessionId, "--id"),
          command: require(flags.command, "--command"),
          output: flags["output-file"] ? readText(flags["output-file"]) : flags.output || "",
          exitCode: flags["exit-code"] !== undefined ? Number(flags["exit-code"]) : undefined
        }))
      }
      if (action === "ingest") {
        return print(ingestToolCalls(db, {
          sessionId: require(flags.id || sessionId, "--id"),
          events: readText(flags.file) || readStdin() || ""
        }))
      }
      throw new Error("usage: mem session start|end|diary|tool|ingest")
    }

    case "remember": {
      const project = register(db, flags.path || cwd)
      const scope = flags.scope || "project"
      if (scope === "global" && !flags["allow-global"]) {
        throw new Error("global notes are read-only to sessions; promote through the dream review gate")
      }
      const result = recordNote(db, project, {
        projectId: project.id,
        scope,
        topic: flags.topic || "general",
        kind: flags.kind || "fact",
        body: textArg(flags, rest),
        confidence: flags.confidence === undefined ? 0.6 : Number(flags.confidence),
        provenance: flags.provenance || project.slug,
        sessionId
      }, { dir: flags.dir || null })
      return print({ ...result, scope, project: project.slug })
    }

    case "draft": {
      const action = rest[0] || "add"
      const id = require(flags.session || sessionId, "--session")
      const project = register(db, flags.path || cwd)
      if (action === "add") {
        return print(draftAdd(db, {
          sessionId: id,
          projectId: project.id,
          topic: flags.topic || "general",
          kind: flags.kind || "fact",
          body: textArg(flags, rest.slice(1)),
          confidence: flags.confidence === undefined ? 0.5 : Number(flags.confidence),
          provenance: flags.provenance || id
        }))
      }
      if (action === "list") return print(draftList(db, { sessionId: id, projectId: project.id }))
      if (action === "commit") {
        return print(draftCommit(db, {
          sessionId: id,
          id: rest[1] ? Number(rest[1]) : null,
          project
        }))
      }
      if (action === "drop") {
        return print(draftDrop(db, { sessionId: id, id: rest[1] ? Number(rest[1]) : null }))
      }
      throw new Error("usage: mem draft add|list|commit|drop [ID] --session ID")
    }

    case "steering": {
      const project = flags.path ? register(db, flags.path) : byPath(db, cwd) || register(db, cwd)
      if (rest[0] === "init" || flags.init) return print(steeringEnsure(project, { dir: flags.dir || null }))
      return print(steeringDescribe(project, { dir: flags.dir || null }))
    }

    case "sync": {
      const project = flags.path ? register(db, flags.path) : byPath(db, cwd) || register(db, cwd)
      return print(syncTopics(db, project, { dir: flags.dir || null }))
    }

    case "topics": {
      const project = flags.path ? byPath(db, flags.path) : byPath(db, cwd)
      if (!project) return print({ topics: [ ] })
      return print({ project: project.slug, topics: topicCounts(db, project) })
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
        topic: note.topic,
        body: note.body,
        confidence: Number(note.confidence.toFixed(2)),
        use_count: note.use_count,
        score: Number(note.score.toFixed(3))
      })))
    }

    case "use": {
      const project = byPath(db, flags.path || cwd)
      return print(recordUse(db, {
        noteId: Number(require(flags.note || rest[0], "NOTE")),
        projectId: project ? project.id : null
      }))
    }

    case "dream": {
      if (rest[0] === "fork") {
        const result = fork(db, { out: flags.out || rest[1] || null })
        if (flags.path) {
          process.stdout.write(`${result.out}\n`)
          return result
        }
        return print(result)
      }
      if (rest[0] === "transcripts") {
        return print(transcripts(db, { dir: flags.dir || null, since: flags.since || null }))
      }
      if (rest[0] === "propose") {
        return print(propose(db, { sessionId: flags.session || null, candidates: readCandidates(rest[1]) }))
      }
      if (rest[0] === "collect") {
        return print(collect(db, rest[1] || flags.out, { minPrevalence: minPrevalenceFlag(flags) }))
      }
      if (rest[0] === "failures") {
        const project = flags.path ? byPath(db, flags.path) : byPath(db, cwd)
        const projectId = project ? project.id : null
        return print({
          failures: failedToolCalls(db, { projectId, since: flags.since || null }),
          recurring: recurringToolCalls(db, {
            projectId,
            since: flags.since || null,
            minSessions: flags.minSessions ? Number(flags.minSessions) : 2
          })
        })
      }
      if (rest[0] === "stage") {
        return print(stage(db, {
          candidates: readCandidates(rest[1]),
          since: flags.since || null,
          minPrevalence: minPrevalenceFlag(flags)
        }))
      }
      if (rest[0] === "review") {
        const report = review(db, Number(require(rest[1], "RUN")))
        if (flags.json) return print(report)
        process.stdout.write(`${formatReview(report)}\n`)
        return report
      }
      if (rest[0] === "apply") {
        return print(apply(db, Number(require(rest[1], "RUN")), { projection }))
      }
      if (rest[0] === "reject") {
        return print(reject(db, Number(require(rest[1], "RUN"))))
      }
      if (rest[0] === "revert") {
        return print(revert(db, Number(require(rest[1], "RUN")), { projection }))
      }
      if (rest[0] === "verify") {
        const project = flags.path ? byPath(db, flags.path) : byPath(db, cwd)
        return print(verify(db, {
          projectId: project ? project.id : null,
          execute: Boolean(flags.execute) || process.env.MEM_VERIFY_EXECUTE === "1",
          dir: flags.dir || null,
          projection
        }))
      }
      if (rest[0] === "organize") {
        const project = flags.path ? register(db, flags.path) : byPath(db, cwd) || register(db, cwd)
        return print(organize(db, {
          projectId: project.id,
          dir: flags.dir || null,
          splitAt: flags.splitAt ? Number(flags.splitAt) : undefined,
          autoApply: flags.stage ? false : true,
          projection
        }))
      }
      if (rest[0] === "enrich") {
        const project = flags.path ? byPath(db, flags.path) : byPath(db, cwd)
        return print(enrich(db, {
          projectId: project ? project.id : null,
          since: flags.since || null,
          projection
        }))
      }
      if (flags.packet) {
        const project = flags.path ? byPath(db, flags.path) : null
        return print(packet(db, {
          projectId: project ? project.id : null,
          since: flags.since || new Date(Date.now() - 86400000).toISOString()
        }))
      }
      if (flags.apply) {
        const planned = consolidate(db, readCandidates(flags.apply))
        const staged = stage(db, {
          candidates: planned.proposals,
          since: flags.since || null,
          minPrevalence: minPrevalenceFlag(flags)
        })
        const applied = apply(db, staged.runId, { projection })
        return print({ ...staged, merged_candidates: planned.merged, ...applied })
      }
      if (flags.auto) {
        const targets = flags.path
          ? [ register(db, flags.path) ]
          : list(db).filter((project) => project.status === "active")
        const report = { projects: [ ], organized: [ ], enriched: [ ], checked: [ ] }
        for (const project of targets) {
          report.organized.push(organize(db, { projectId: project.id, dir: flags.dir || null, projection }))
        }
        const pruning = decay(db, { archiveDays: flags.archiveDays ? Number(flags.archiveDays) : 30 })
        const archived = archiveStale(db, flags.archiveDays ? Number(flags.archiveDays) : 30)
        for (const project of targets) {
          report.projects.push(project.slug)
          report.enriched.push(enrich(db, { projectId: project.id, since: flags.since || null, projection }))
          report.checked.push(verify(db, {
            projectId: project.id,
            execute: Boolean(flags.execute) || process.env.MEM_VERIFY_EXECUTE === "1",
            dir: flags.dir || null,
            projection
          }))
        }
        return print({ ...report, ...pruning, archived })
      }
      throw new Error("usage: mem dream --packet | stage FILE | propose [FILE] [--session ID] | fork [--path] | transcripts [--dir DIR] | collect MEM_OUT | failures | review RUN | apply RUN | reject RUN | revert RUN | verify | organize | enrich | --apply FILE | --auto")
    }

    case "promote": {
      const result = proposePromotions(db)
      if (flags.apply && result.runId) {
        return print({ ...result, ...apply(db, result.runId, { projection }) })
      }
      return print(result)
    }

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

function projectionFlag(flags) {
  if (flags.projection) return true
  if (flags.markdown) return true
  return undefined
}

function minPrevalenceFlag(flags) {
  const value = flags["min-prevalence"] ?? flags.minPrevalence
  if (value === undefined || value === true) return 1
  return Number(value)
}

function textArg(flags, rest) {
  const value = flags.body || rest.join(" ") || readStdin()
  if (!value) throw new Error("no body given (pass --body, positionally, or on stdin)")
  return value.trim()
}

function readCandidates(source) {
  const text = source === undefined || source === true ? readStdin() : readText(source)
  if (!text) throw new Error("no candidates given (pass a FILE or pipe JSON on stdin)")
  const parsed = JSON.parse(text)
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates
  if (!Array.isArray(candidates)) {
    throw new Error("candidates must be a JSON array or an object with a candidates array")
  }
  return candidates
}

function readLessons(source) {
  const text = source === undefined || source === true ? readStdin() : readText(source)
  if (!text || !String(text).trim()) return [ ]
  const parsed = JSON.parse(text)
  const lessons = Array.isArray(parsed) ? parsed : parsed.lessons || parsed.candidates
  if (!Array.isArray(lessons)) {
    throw new Error("lessons must be a JSON array or an object with a lessons array")
  }
  return lessons
}

function readText(source) {
  if (!source || source === true) return null
  return fs.readFileSync(path.resolve(source), "utf8")
}

function diaryArg(value) {
  if (!value || value === true) return null
  const file = path.resolve(value)
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : String(value)
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
    "mem session start|end|diary|import|tool|ingest [--id ID] [--diary FILE] [--learn FILE] [--path DIR]",
    "mem draft add|list|commit|drop [ID] --session ID",
    "mem steering [init] [--path DIR]",
    "mem remember --body TEXT [--topic deploy] [--kind gotcha] [--scope project]",
    "mem recall [--query TEXT] [--limit 12]",
    "mem use NOTE",
    "mem sync | topics",
    "mem dream --packet | stage FILE | propose [FILE] [--session ID] | fork [--path] | transcripts [--dir DIR] | collect MEM_OUT | failures | review RUN [--json] | apply RUN | reject RUN | revert RUN | verify [--execute] | organize [--stage] | enrich [--since DATE] | --apply FILE | --auto",
    "mem revisions [--note ID] [--run RUN] [--limit 50]",
    "mem promote [--apply] | decay | materialize | stats"
  ].join("\n")
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return value
}
