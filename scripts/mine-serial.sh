#!/usr/bin/env bash
# Ask every old opencode session to write its memories, one at a time.
#
#   ./scripts/mine-serial.sh                 every root session, newest first
#   LIMIT=5 ./scripts/mine-serial.sh         first five only
#   MIN_MESSAGES=20 ./scripts/mine-serial.sh skip short sessions
#   DAYS=7 ./scripts/mine-serial.sh          only sessions touched this week
#   FORK=0 ./scripts/mine-serial.sh          append to the real tab, not a fork
#   DRY_RUN=1 ./scripts/mine-serial.sh       print the queue, call no model
#   RETRY=1 ./scripts/mine-serial.sh         retry sessions that wrote bad JSON
#
#   ./scripts/mine-serial.sh merge           combine the JSON files into candidates
#
# Each session writes .scratch/memories/<session>.json. An existing file means
# done, so the script resumes where it stopped. Logs sit beside the files.
# Feed the result to: mem dream stage .scratch/candidates.json
set -euo pipefail

cd "$(dirname "$0")/.."

MINE="node scripts/mine.mjs"
MEM="${MEM:-node bin/mem.js}"
MODEL="${MODEL:-ollama/deepseek-v4.1-flash:1017-cloud}"
OUT="${OUT:-.scratch/memories}"
MIN_MESSAGES="${MIN_MESSAGES:-6}"
LIMIT="${LIMIT:-0}"
DAYS="${DAYS:-0}"
TIMEOUT="${TIMEOUT:-600}"
FORK="${FORK:-1}"
ARCHIVE="${ARCHIVE:-0}"
RETRY="${RETRY:-0}"
INCLUDE_HOME="${INCLUDE_HOME:-0}"
PROJECTS="${PROJECTS:-}"
ONLY="${ONLY:-}"
DRY_RUN="${DRY_RUN:-0}"

if [ "${1:-}" = "merge" ]; then
  $MINE merge "$OUT" "${2:-.scratch/candidates.json}"
  exit 0
fi

mkdir -p "$OUT" .scratch
QUEUE=.scratch/mine-queue.tsv
OUT_ABS="$(cd "$OUT" && pwd)"

$MINE list "$MIN_MESSAGES" "$LIMIT" "$DAYS" "$INCLUDE_HOME" "$PROJECTS" > "$QUEUE"
total=$(wc -l < "$QUEUE")
echo "queue: $total sessions (min $MIN_MESSAGES messages, limit ${LIMIT:-all}, days ${DAYS:-all})"

slug_for() {
  if [ "$DRY_RUN" = "1" ]; then
    node -e 'process.stdout.write(String(process.argv[1]).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + "\n")' "$(basename "$1")"
    return 0
  fi
  $MEM register "$1" | node -e '
    let input = ""
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).slug + "\n"))
  '
}

prompt() {
  local id="$1" slug="$2" target="$3"
  cat <<EOF
This session is over. Do not continue its work. Your only job now is to distill it into durable memory for future agents.

Write exactly one file, and nothing else: $target
Its contents: a JSON array. Each item has this shape:
{"op":"insert","project":"$slug","scope":"project","topic":"deploy","kind":"fact","body":"...","confidence":0.6,"provenance":"file:line or command","session":"$id","reason":"why this matters","examples":[{"session":"$id","excerpt":"short quote"}]}

Rules:
- op is always "insert"; near-duplicates merge automatically.
- body must be checkable: a path, a command, a version, or a specific gotcha. Never general advice, never a restatement of the code.
- kind is fact, gotcha, convention, or decision.
- topic is the subject a future agent would search for, e.g. deploy, flaky-tests, repo-layout, api-routes.
- Use scope "global" and omit "project" only for a claim that holds in every repository.
- Provenance must be something a reader can check, e.g. "src/db.js:42" or "npm test failed on Node 20".
- Never record secrets, tokens, API keys, passwords, or credentials.
- Do not modify any other file, and do not run commands to re-verify anything; work from this conversation only.
- If nothing durable was learned, write [].

Write the file with the write tool, then reply "done" and stop.
EOF
}

count_json() {
  node -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const items = Array.isArray(parsed) ? parsed : parsed.candidates
    if (!Array.isArray(items)) throw new Error("not an array")
    process.stdout.write(String(items.length))
  ' "$1"
}

one() {
  local id="$1" dir="$2" title="$3"
  local target="$OUT_ABS/$id.json"
  local log="$OUT_ABS/$id.log"

  if [ -f "$target" ]; then
    echo "skip $id (done)"
    return 0
  fi
  if [ -f "$target.bad" ] && [ "$RETRY" != "1" ]; then
    echo "skip $id (bad JSON; RETRY=1 to retry)"
    return 0
  fi

  local slug
  slug=$(slug_for "$dir")
  local run_dir="$dir"
  [ -d "$run_dir" ] || run_dir="$HOME"

  if [ "$DRY_RUN" = "1" ]; then
    echo "would mine $id [$slug] in $run_dir -> $target"
    return 0
  fi

  echo "== $id [$slug] $title"
  local fork_flag=""
  [ "$FORK" = "1" ] && fork_flag="--fork"
  [ "$ARCHIVE" = "1" ] && fork_flag="$fork_flag --archived"

  if ! ( cd "$run_dir" && timeout "$TIMEOUT" opencode run \
      --session "$id" $fork_flag --auto --model "$MODEL" \
      --title "memories: $title" "$(prompt "$id" "$slug" "$target")" ) \
      > "$log" 2>&1; then
    echo "failed $id (see $log)" >&2
    return 0
  fi

  if [ ! -f "$target" ]; then
    if $MINE salvage "$log" "$target" > /dev/null 2>&1; then
      echo "salvaged $id from stdout"
    else
      echo "no output $id (see $log)" >&2
      return 0
    fi
  fi

  local count
  if ! count=$(count_json "$target" 2> /dev/null); then
    mv "$target" "$target.bad"
    echo "invalid JSON $id (moved to $target.bad)" >&2
    return 0
  fi
  $MEM session import --id "$id" --path "$run_dir" --diary "$target" > /dev/null 2>&1 || true
  echo "wrote $count candidates from $id"
}

attempted=0
skipped=0
while IFS=$'\t' read -r id messages dir title; do
  [ -n "$id" ] || continue
  if [ -n "$ONLY" ] && [ "$id" != "$ONLY" ]; then
    continue
  fi
  if [ -f "$OUT_ABS/$id.json" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  one "$id" "$dir" "$title"
  attempted=$((attempted + 1))
done < "$QUEUE"

echo "== attempted $attempted, already done $skipped"
echo "next: ./scripts/mine-serial.sh merge && $MEM dream stage .scratch/candidates.json"
