import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { now } from "./db.js"
import { liveNotes } from "./notes.js"
import { byId } from "./projects.js"
import { stage } from "./dream.js"
import { projectionEnabled, syncTopics } from "./topics.js"

const COMMANDS = new Set([
  "npm", "pnpm", "yarn", "npx", "node", "bun", "deno", "git", "make", "cmake", "cargo", "go",
  "python", "python3", "pytest", "ruby", "rake", "rails", "bundle", "bin/rails", "docker", "docker-compose"
])
const VERSION = /\b(node|eslint|ruby|postgres|postgresql|sqlite|react|next|vite)\s+v?(\d+(?:\.\d+)*)/gi
const SAFE_COMMAND = /^[a-zA-Z0-9_./-]+(?:\s+(?:[a-zA-Z0-9_./:=@%+-]+|"[^"]*"|'[^']*'))*$/
const READ_ONLY = [
  /^(node|npm|pnpm|yarn|npx|bun|deno|ruby|python3?)\s+(--version|-v)$/,
  /^git\s+(rev-parse|status|log|show|ls-files|describe)\b/
]
const CONFIDENCE_BUMP = 0.05
const VERIFY_INTERVAL_MS = 12 * 60 * 60 * 1000

export function verify(db, { projectId = null, execute = false, dir = null, nowAt = new Date(), projection = projectionEnabled() } = { }) {
  const project = projectId === null ? null : byId(db, projectId)
  const notes = liveNotes(db, { projectId })
  const results = { checked: notes.length, true: 0, false: 0, unknown: 0, staged: 0, runId: null }
  const candidates = [ ]

  for (const note of notes) {
    const context = contextFor(db, note, project, dir)
    const check = checkClaim(note, context, { execute })
    if (check.status === "true") {
      results.true += 1
      confirm(db, note, nowAt)
      continue
    }
    if (check.status === "unknown") {
      results.unknown += 1
      continue
    }

    results.false += 1
    markFailed(db, note, check.reason, nowAt)
    const slug = note.project_id ? byId(db, note.project_id)?.slug : null
    const base = {
      project: slug,
      scope: note.scope,
      topic: note.topic || "general",
      kind: note.kind,
      confidence: note.confidence,
      provenance: note.provenance,
      target_id: note.id,
      target_version: note.version,
      reason: check.reason,
      examples: decode(note.examples),
      prevalence: note.prevalence,
      verb: "verify"
    }
    if (check.correction && check.correction.trim() && check.correction !== note.body) {
      candidates.push({ ...base, op: "update", body: check.correction })
    } else {
      candidates.push({ ...base, op: "retire", body: note.body })
    }
  }

  if (candidates.length > 0) {
    const staged = stage(db, { candidates, since: null })
    results.staged = staged.staged
    results.runId = staged.runId
    results.problems = staged.problems
  }
  if (project && projection) results.files = syncTopics(db, project)
  return results
}

export function checkClaim(note, context = { }, options = { }) {
  const body = note.body
  const atoms = backticked(body)
  const checks = [ ]
  const unverified = [ ]

  for (const atom of atoms) {
    if (looksLikeCommand(atom)) {
      if (!SAFE_COMMAND.test(atom)) {
        unverified.push({ reason: `command not safe to run: ${atom}` })
        continue
      }
      if (!options.execute && !readOnly(atom)) {
        unverified.push({ reason: `command not run: ${atom}` })
        continue
      }
      const command = split(atom)
      if (command.length === 0) continue
      checks.push(runCommand(command, context.dir || process.cwd()))
      continue
    }

    if (!looksLikePath(atom)) continue
    const result = checkPath(atom, note, context)
    if (result.state === "true") checks.push({ ok: true, reason: result.reason })
    else if (result.state === "false") checks.push({ ok: false, reason: result.reason, correction: null })
    else unverified.push({ reason: result.reason })
  }

  const versionCheck = checkVersion(body, context)
  if (versionCheck && versionCheck.unknown) unverified.push({ reason: versionCheck.reason })
  else if (versionCheck) checks.push(versionCheck)

  const failed = checks.find((check) => !check.ok)
  if (failed) return { status: "false", reason: failed.reason, correction: failed.correction || null }
  if (checks.length > 0 && unverified.length === 0) {
    return { status: "true", reason: checks.map((check) => check.reason).join("; ") }
  }
  if (unverified.length > 0) {
    return { status: "unknown", reason: unverified.map((entry) => entry.reason).join("; ") }
  }
  return { status: "unknown", reason: "no checkable path, command, or version" }
}

function checkPath(atom, note, context) {
  if (note.scope === "global" && !path.isAbsolute(atom)) {
    return { state: "unknown", reason: `relative path not resolved across projects: ${atom}` }
  }
  const target = path.resolve(context.dir || process.cwd(), atom)
  if (fs.existsSync(target)) return { state: "true", reason: `path exists: ${atom}` }
  if (isAbsolute(atom) || isBareName(atom)) {
    return { state: "unknown", reason: `not found as a file; a route or generated name is not evidence: ${atom}` }
  }
  return { state: "false", reason: `path missing: ${atom}` }
}

function isAbsolute(value) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
}

function isBareName(value) {
  return !value.includes("/") && !value.includes("\\")
}

function contextFor(db, note, project, dir) {
  const owner = note.project_id ? byId(db, note.project_id) : project
  return {
    dir: dir || (owner ? owner.path : process.cwd()),
    project: owner,
    package: owner ? readPackage(owner.path) : null
  }
}

function confirm(db, note, at) {
  const previous = note.verified_at ? new Date(note.verified_at).getTime() : 0
  if (at.getTime() - previous < VERIFY_INTERVAL_MS) return
  const confidence = Math.min(1, Number(note.confidence) + CONFIDENCE_BUMP)
  db.prepare("UPDATE notes SET confidence = ?, verified_at = ?, verify_result = 'true' WHERE id = ?")
    .run(confidence, now(at), note.id)
}

function markFailed(db, note, reason, at) {
  db.prepare("UPDATE notes SET verified_at = ?, verify_result = 'false' WHERE id = ?")
    .run(now(at), note.id)
  void reason
}

function backticked(body) {
  return Array.from(String(body).matchAll(/`([^`]+)`/g)).map((match) => match[1].trim())
}

function looksLikePath(value) {
  if (!value || value.includes(" ") || value.includes("=")) return false
  if (/^https?:/.test(value)) return false
  if (/[*<>%#]/.test(value)) return false
  if (value.includes(":")) return false
  if (looksLikeCommand(value)) return false
  return value.includes("/") || /\.(js|mjs|cjs|ts|tsx|jsx|rb|json|md|yml|yaml|toml|sql|sh|css|scss|html|py|go|rs)$/.test(value)
}

function looksLikeCommand(value) {
  const first = String(value).split(/\s+/)[0]
  return COMMANDS.has(first)
}

function readOnly(value) {
  return READ_ONLY.some((pattern) => pattern.test(value))
}

function split(value) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) || [ ]).map((part) => part.replace(/^["']|["']$/g, ""))
}

function runCommand(command, cwd) {
  try {
    execFileSync(command[0], command.slice(1), {
      cwd,
      timeout: 5000,
      stdio: "pipe",
      env: { ...process.env, CI: "1" }
    })
    return { ok: true, reason: `command passed: ${command.join(" ")}` }
  } catch (error) {
    return {
      ok: false,
      reason: `command failed: ${command.join(" ")} (${error.status ?? error.code ?? "error"})`,
      correction: null
    }
  }
}

function checkVersion(body, context) {
  const claims = Array.from(String(body).matchAll(VERSION))
  if (claims.length === 0) return null

  let checked = 0
  const unresolved = [ ]
  for (const claim of claims) {
    const name = claim[1].toLowerCase()
    const claimed = claim[2]
    const actual = actualVersion(name, context)
    if (!actual) {
      unresolved.push(`${name} ${claimed}`)
      continue
    }
    checked += 1
    if (!satisfied(name, claimed, actual)) {
      return {
        ok: false,
        reason: `version mismatch: ${name} ${claimed} is ${actual}`,
        correction: String(body).replace(claim[0], `${name} ${major(actual)}`)
      }
    }
  }
  if (unresolved.length > 0) {
    return { unknown: true, reason: `version not resolved: ${unresolved.join(", ")}` }
  }
  if (checked === 0) {
    return { unknown: true, reason: `version not resolved: ${claims.map((claim) => `${claim[1]} ${claim[2]}`).join(", ")}` }
  }
  return { ok: true, reason: "versions agree" }
}

function actualVersion(name, context) {
  if (name === "node") return process.versions.node
  if (name === "ruby") {
    const file = path.join(context.dir || "", ".ruby-version")
    if (fs.existsSync(file)) return numeric(fs.readFileSync(file, "utf8"))
    return null
  }
  const pkg = context.package
  if (!pkg) return null
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
  const key = name === "postgresql" ? "postgres" : name
  return all[key] ? numeric(all[key]) : null
}

function satisfied(name, claimed, actual) {
  const left = claimed.split(".").map(Number)
  const right = numeric(actual).split(".").map(Number)
  if (!exact(name)) {
    if (right[0] > left[0]) return true
    if (right[0] < left[0]) return false
    if (left.length === 1 || right.length === 1) return true
    return right[1] >= left[1]
  }
  return left.every((part, index) => right[index] === part)
}

function exact(name) {
  return [ "eslint", "react", "next", "vite" ].includes(name)
}

function numeric(value) {
  return String(value).replace(/[^0-9.]/g, "") || "0"
}

function major(value) {
  return numeric(value).split(".")[0]
}

function readPackage(dir) {
  const file = path.join(dir, "package.json")
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
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
