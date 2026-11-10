import { liveNotes, normalizeTopic } from "./notes.js"
import { byId } from "./projects.js"
import { apply, stage } from "./dream.js"
import { syncTopics, topicCounts } from "./topics.js"
import { significant } from "./text.js"

const SPLIT_AT = 20

export function organize(db, { projectId = null, dir = null, splitAt = SPLIT_AT, autoApply = true } = { }) {
  const project = projectId === null ? null : byId(db, projectId)
  if (!project) throw new Error("organize needs a project")

  const notes = liveNotes(db, { projectId: project.id })
  const moves = new Map()
  let merged = 0
  let split = 0

  const before = topicCounts(db, project)
  const groups = new Map()
  for (const item of before) {
    const key = canonicalTopic(item.topic)
    if (!groups.has(key)) groups.set(key, [ ])
    groups.get(key).push(item)
  }

  for (const [ canonical, group ] of groups) {
    if (group.length < 2) continue
    const winner = group.find((item) => item.topic === canonical) ||
      group.slice().sort((a, b) => b.notes - a.notes || a.topic.localeCompare(b.topic))[0]
    for (const loser of group) {
      if (loser.topic === winner.topic) continue
      merged += 1
      for (const note of notes.filter((entry) => normalizeTopic(entry.topic) === loser.topic)) {
        plan(moves, note, winner.topic, `organize: merged ${loser.topic} into ${winner.topic}`, project.slug)
      }
    }
  }

  for (const item of before) {
    if (item.notes <= splitAt) continue
    const own = notes.filter((note) => normalizeTopic(note.topic) === item.topic)
    const byKind = new Map()
    for (const note of own) {
      if (!byKind.has(note.kind)) byKind.set(note.kind, [ ])
      byKind.get(note.kind).push(note)
    }
    if (byKind.size < 2) continue
    const dominant = Array.from(byKind.entries()).sort((a, b) => b[1].length - a[1].length)[0][0]
    for (const [ kind, list ] of byKind) {
      if (kind === dominant) continue
      const target = `${item.topic}-${kind}`
      split += 1
      for (const note of list) plan(moves, note, target, `organize: split ${item.topic} by ${kind}`, project.slug)
    }
  }

  const topics = Array.from(new Set(before.map((item) => item.topic)))
  for (const note of notes) {
    if (moves.has(note.id)) continue
    const best = bestTopic(note, topics)
    if (!best) continue
    const current = normalizeTopic(note.topic)
    const currentScore = scoreTopic(current, note.body)
    if (current === "general" && best.score >= 1) {
      plan(moves, note, best.topic, `organize: moved a general claim to ${best.topic}`, project.slug)
    } else if (best.score >= currentScore + 2 && best.score >= 2) {
      plan(moves, note, best.topic, `organize: moved a claim from ${current} to ${best.topic}`, project.slug)
    }
  }

  const candidates = Array.from(moves.values())
  let applied = null
  let runId = null
  if (candidates.length > 0) {
    const staged = stage(db, { candidates, since: null })
    runId = staged.runId
    if (autoApply) applied = apply(db, runId)
  }

  const files = syncTopics(db, project, { dir })
  return {
    runId,
    moved: candidates.length,
    merged,
    split,
    applied: applied ? applied.updated : 0,
    problems: applied ? applied.problems : [ ],
    files
  }
}

function plan(moves, note, topic, reason, projectSlug) {
  const target = normalizeTopic(topic)
  if (target === normalizeTopic(note.topic)) return
  moves.set(note.id, {
    op: "update",
    project: note.project_id ? projectSlug : null,
    scope: note.scope,
    topic: target,
    kind: note.kind,
    body: note.body,
    confidence: note.confidence,
    provenance: note.provenance,
    target_id: note.id,
    target_version: note.version,
    reason,
    verb: "organize"
  })
}

function bestTopic(note, topics) {
  const body = significant(note.body).join(" ")
  let best = null
  for (const topic of topics) {
    if (topic === normalizeTopic(note.topic)) continue
    const score = scoreTopic(topic, body)
    if (score === 0) continue
    if (!best || score > best.score || (score === best.score && topic.localeCompare(best.topic) < 0)) {
      best = { topic, score }
    }
  }
  return best
}

function scoreTopic(topic, body) {
  const words = new Set(significant(body))
  return normalizeTopic(topic).split("-").filter((part) => part.length >= 3 && words.has(part)).length
}

export function canonicalTopic(topic) {
  const parts = normalizeTopic(topic).split("-")
  const last = parts.pop()
  parts.push(canonicalWord(last))
  return parts.join("-")
}

function canonicalWord(word) {
  let value = word
  const stem = value.replace(/(ments?|ings?|tions?)$/, "")
  if (stem.length >= 3 && stem !== value) value = stem
  if (/[^aeiou]ies$/.test(value)) return `${value.slice(0, -3)}y`
  if (/(ss|us|is)$/.test(value)) return value
  return value.replace(/s$/, "")
}
