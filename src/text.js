const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "always", "another", "because", "been", "before",
  "being", "between", "both", "cannot", "could", "does", "doing", "down", "during", "each", "from",
  "have", "having", "here", "into", "just", "like", "more", "most", "must", "never", "only", "other",
  "over", "same", "should", "some", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "very", "what", "when", "where", "which",
  "while", "will", "with", "would", "your", "note", "notes", "uses", "using", "needs", "need"
])

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._/-]*/g) || [ ]
}

export function significant(text) {
  return tokens(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token))
}

export function overlap(left, right) {
  const a = new Set(significant(left))
  const b = new Set(significant(right))
  let shared = 0
  for (const token of a) {
    if (b.has(token)) shared += 1
  }
  return shared
}

export function shared(left, right) {
  const b = new Set(significant(right))
  return Array.from(new Set(significant(left))).filter((token) => b.has(token))
}
