const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "always", "another", "because", "been", "before",
  "being", "between", "both", "cannot", "could", "does", "doing", "down", "during", "each", "from",
  "have", "having", "here", "into", "just", "like", "more", "most", "must", "never", "only", "other",
  "over", "same", "should", "some", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "very", "what", "when", "where", "which",
  "while", "will", "with", "would", "your", "note", "notes", "uses", "using", "needs", "need"
])

const COMMANDS = new Set([
  "npm", "pnpm", "yarn", "npx", "node", "bun", "deno", "git", "make", "cmake", "cargo", "go",
  "python", "python3", "pytest", "ruby", "rake", "rails", "bundle", "bin/rails", "docker",
  "docker-compose", "eslint", "prettier", "vitest", "jest"
])

const VERSION = /\b[a-z][a-z0-9-]*\s+v?\d+(?:\.\d+)+/gi
const BACKTICK = /`([^`]+)`/g

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._/-]*/g) || [ ]
}

export function significant(text) {
  return tokens(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token))
}

export function claimTokens(text) {
  return tokens(text).filter((token) => {
    if (/^\d+$/.test(token)) return true
    return token.length >= 4 && !STOPWORDS.has(token)
  })
}

export function overlap(left, right) {
  const a = new Set(claimTokens(left))
  const b = new Set(claimTokens(right))
  let shared = 0
  for (const token of a) {
    if (b.has(token)) shared += 1
  }
  return shared
}

export function shared(left, right) {
  const b = new Set(claimTokens(right))
  return Array.from(new Set(claimTokens(left))).filter((token) => b.has(token))
}

export function similarity(left, right) {
  const a = new Set(claimTokens(left))
  const b = new Set(claimTokens(right))
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const token of a) {
    if (b.has(token)) common += 1
  }
  return common / (a.size + b.size - common)
}

export function mentions(body, text) {
  const wanted = new Set(claimTokens(body))
  if (wanted.size === 0) return false
  const seen = new Set(claimTokens(text))
  let shared = 0
  for (const token of wanted) {
    if (seen.has(token)) shared += 1
  }
  return shared >= (wanted.size <= 3 ? 1 : 2)
}

export function sameClaim(left, right, { threshold = 0.6 } = { }) {
  if (!left || !right) return false
  const leftNumbers = numbers(left)
  const rightNumbers = numbers(right)
  if (leftNumbers && rightNumbers && leftNumbers !== rightNumbers) return false
  if (overlap(left, right) < 2 && claimTokens(left).length > 1 && claimTokens(right).length > 1) {
    return false
  }
  return similarity(left, right) >= threshold
}

function numbers(text) {
  return claimTokens(text).filter((token) => /^\d+$/.test(token)).sort().join("|")
}

export function clarity(text) {
  const body = String(text || "")
  let score = 0
  for (const match of body.matchAll(BACKTICK)) {
    const atom = match[1].trim()
    if (!atom) continue
    score += 4
    if (looksLikePath(atom) || looksLikeCommand(atom)) score += 3
  }
  for (const match of body.matchAll(VERSION)) {
    void match
    score += 2
  }
  const paths = body.match(/\b[a-z0-9_.-]+\/[a-z0-9_./-]+/gi) || [ ]
  score += Math.min(paths.length, 4) * 2
  score += Math.min(significant(body).length, 12) * 0.1
  score -= Math.min(body.length, 300) / 300
  return score
}

export function clearer(candidate, existing) {
  if (!candidate) return false
  if (!existing) return true
  return clarity(candidate) > clarity(existing)
}

export function checkable(text) {
  const body = String(text || "")
  if (BACKTICK.test(body)) {
    BACKTICK.lastIndex = 0
    return true
  }
  BACKTICK.lastIndex = 0
  if (VERSION.test(body)) {
    VERSION.lastIndex = 0
    return true
  }
  VERSION.lastIndex = 0
  if (/\b[a-z0-9_.-]+\/[a-z0-9_./-]+\b/i.test(body)) return true
  if (/\b[a-z0-9_-]+\.(js|mjs|cjs|ts|tsx|jsx|rb|json|md|yml|yaml|toml|sql|sh|css|scss|html|py|go|rs)\b/i.test(body)) {
    return true
  }
  return false
}

export function looksLikeCommand(value) {
  const first = String(value || "").split(/\s+/)[0]
  return COMMANDS.has(first) || first.startsWith("bin/") || first.startsWith("./")
}

function looksLikePath(value) {
  return /[/.]/.test(value)
}
