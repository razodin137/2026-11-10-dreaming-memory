const SYNONYMS = new Map([
  [ "test", "test" ],
  [ "tests", "test" ],
  [ "testing", "test" ],
  [ "tested", "test" ],
  [ "check", "test" ],
  [ "checks", "test" ],
  [ "checking", "test" ],
  [ "verify", "test" ],
  [ "verification", "test" ],
  [ "spec", "test" ],
  [ "specs", "test" ],
  [ "lint", "test" ],
  [ "lints", "test" ],
  [ "linting", "test" ],
  [ "ci", "test" ],
  [ "qa", "test" ],
  [ "gate", "test" ],
  [ "deploy", "deploy" ],
  [ "deploys", "deploy" ],
  [ "deployment", "deploy" ],
  [ "deployments", "deploy" ],
  [ "release", "deploy" ],
  [ "releases", "deploy" ],
  [ "releasing", "deploy" ],
  [ "ship", "deploy" ],
  [ "shipping", "deploy" ],
  [ "config", "config" ],
  [ "configuration", "config" ],
  [ "configurations", "config" ],
  [ "settings", "config" ],
  [ "setting", "config" ],
  [ "setup", "config" ],
  [ "dependency", "dependencies" ],
  [ "dependencies", "dependencies" ],
  [ "deps", "dependencies" ],
  [ "dep", "dependencies" ],
  [ "package", "dependencies" ],
  [ "packages", "dependencies" ],
  [ "packaging", "dependencies" ],
  [ "database", "database" ],
  [ "databases", "database" ],
  [ "db", "database" ],
  [ "sqlite", "database" ],
  [ "postgres", "database" ],
  [ "postgresql", "database" ],
  [ "mysql", "database" ],
  [ "build", "build" ],
  [ "builds", "build" ],
  [ "building", "build" ],
  [ "bundle", "build" ],
  [ "bundling", "build" ],
  [ "compile", "build" ],
  [ "compilation", "build" ],
  [ "docs", "docs" ],
  [ "doc", "docs" ],
  [ "documentation", "docs" ],
  [ "readme", "docs" ],
  [ "route", "routing" ],
  [ "routes", "routing" ],
  [ "routing", "routing" ],
  [ "flaky", "flaky-test" ],
  [ "auth", "auth" ],
  [ "authentication", "auth" ],
  [ "login", "auth" ],
  [ "logging", "logging" ],
  [ "logs", "logging" ]
])

const GENERIC = new Set([ "command", "commands", "cmd", "cmds", "thing", "things" ])

const LABELS = new Map([
  [ "test", "testing" ],
  [ "flaky-test", "flaky-tests" ],
  [ "deploy", "deploy" ],
  [ "config", "config" ],
  [ "dependencies", "dependencies" ],
  [ "database", "database" ],
  [ "build", "build" ],
  [ "docs", "docs" ],
  [ "routing", "routing" ],
  [ "auth", "auth" ],
  [ "logging", "logging" ]
])

export function normalizeTopic(value) {
  const slug = String(value || "general").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "general"
}

export function topicKey(value) {
  const parts = normalizeTopic(value).split("-").map(canonicalWord).filter(Boolean)
  const meaningful = parts.filter((part) => !GENERIC.has(part))
  const kept = meaningful.length > 0 ? meaningful : parts
  return Array.from(new Set(kept)).sort().join("-") || "general"
}

export function topicLabel(key) {
  return LABELS.get(key) || key
}

export function resolveTopic(requested, existing = [ ]) {
  const wanted = normalizeTopic(requested)
  const list = existing.map(asTopic).filter((item) => item.topic)
  if (list.some((item) => item.topic === wanted)) return wanted

  const key = topicKey(wanted)
  const same = list.filter((item) => topicKey(item.topic) === key)
  if (same.length > 0) return bestExisting(same, key)

  const related = list.filter((item) => relatedKeys(key, topicKey(item.topic)))
  if (related.length > 0) return bestExisting(related, key)

  return labelFor(key, wanted)
}

export function preferredTopic(key, existing = [ ]) {
  const list = existing.map(asTopic).filter((item) => item.topic && topicKey(item.topic) === key)
  const label = LABELS.get(key)
  if (label && list.some((item) => item.topic === label)) return label
  if (label) return label
  return list.length > 0 ? bestExisting(list, key) : key
}

export function sameSubject(left, right) {
  return topicKey(left) === topicKey(right)
}

function asTopic(value) {
  if (typeof value === "string") return { topic: normalizeTopic(value), notes: 1 }
  const topic = normalizeTopic(value && (value.topic || value.subject))
  return { topic, notes: Number(value && value.notes) || 0 }
}

function bestExisting(list, key) {
  const label = LABELS.get(key)
  const named = label ? list.filter((item) => item.topic === label) : [ ]
  const pool = named.length > 0 ? named : list
  return pool
    .slice()
    .sort((a, b) => b.notes - a.notes || a.topic.length - b.topic.length || a.topic.localeCompare(b.topic))[0]
    .topic
}

function labelFor(key, fallback) {
  return LABELS.get(key) || normalizeTopic(fallback)
}

function relatedKeys(left, right) {
  if (!left || !right || left === "general" || right === "general") return false
  if (left === right) return true
  const a = new Set(left.split("-"))
  const b = new Set(right.split("-"))
  const small = a.size <= b.size ? a : b
  const large = a.size <= b.size ? b : a
  let shared = 0
  for (const part of small) {
    if (large.has(part)) shared += 1
  }
  return shared > 0 && shared === small.size
}

function canonicalWord(word) {
  let value = String(word || "").toLowerCase()
  if (SYNONYMS.has(value)) return SYNONYMS.get(value)
  value = singular(value)
  if (SYNONYMS.has(value)) return SYNONYMS.get(value)
  return value
}

function singular(word) {
  let value = word
  const stem = value.replace(/(ments?|ings?|tions?)$/, "")
  if (stem.length >= 3 && stem !== value) value = stem
  if (/[^aeiou]ies$/.test(value)) return `${value.slice(0, -3)}y`
  if (/(ss|us|is)$/.test(value)) return value
  return value.replace(/s$/, "")
}
