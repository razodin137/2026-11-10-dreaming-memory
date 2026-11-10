import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./db.js"
import { significant } from "./text.js"

export const FILE = "STEERING.md"

export const DEFAULT = `# Memory steering

One file per memory store: what is worth keeping, and what to drop.

## Keep

- Commands, paths, versions, and gotchas that cost a session time.
- The reproducing command and the exact error text.
- Decisions a future agent would otherwise reverse.
- Prevalence: how many sessions showed the same thing.

## Drop

- Scratch lint commands, formatter output, and one-off local experiments.
- Container or machine trivia that does not change how the project is built.
- Recaps of the prompt runner or the agent conversation.
- Restatements of what the code already makes obvious.
`

export function globalPath(options = { }) {
  return path.resolve(options.file || process.env.MEM_STEERING || path.join(ROOT, FILE))
}

export function projectPath(project, options = { }) {
  const dir = options.dir || process.env.MEMORY_DIR || path.join(project.path, "memory")
  return path.join(path.resolve(dir), FILE)
}

export function paths(project, options = { }) {
  const list = [ ]
  if (project) list.push(projectPath(project, options))
  list.push(globalPath(options))
  return Array.from(new Set(list))
}

export function read(project, options = { }) {
  const chunks = [ ]
  for (const file of paths(project, options)) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8").trim()
    if (text) chunks.push(text)
  }
  return chunks.length > 0 ? chunks.join("\n\n") : null
}

export function ensure(project, options = { }) {
  const file = projectPath(project, options)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, DEFAULT)
  }
  return { path: file, text: fs.readFileSync(file, "utf8") }
}

export function describe(project, options = { }) {
  const files = paths(project, options).filter((file) => fs.existsSync(file))
  return { files, text: read(project, options), default: DEFAULT }
}

export function dropper(project, options = { }) {
  const text = options.text === undefined ? read(project, options) : options.text
  const rules = parse(text)
  return (body) => classify(body, rules).drop
}

export function classify(body, rules) {
  const words = new Set(significant(body))
  let best = { drop: false, score: 0, reason: null }
  for (const rule of rules.drop) {
    const score = rule.tokens.filter((token) => words.has(token)).length
    if (score >= 2 && score > best.score) best = { drop: true, score, reason: rule.text }
  }
  return best
}

export function parse(text) {
  const rules = { keep: [ ], drop: [ ] }
  if (!text) return rules
  let section = null
  for (const line of String(text).split("\n")) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      const name = heading[1].trim().toLowerCase()
      section = name.startsWith("keep") ? "keep" : name.startsWith("drop") ? "drop" : null
      continue
    }
    if (!section) continue
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (!bullet) continue
    const value = bullet[1].trim()
    rules[section].push({ text: value, tokens: significant(value) })
  }
  return rules
}
