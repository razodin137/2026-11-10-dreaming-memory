#!/usr/bin/env bash
# Run one night of dreaming.
#
#   ./scripts/dream.sh                     fan out: one agent per undistilled session
#   MODE=single ./scripts/dream.sh         one packet, one agent (quiet night)
#   APPLY=0 ./scripts/dream.sh             collect, then stop for review
#   MEM_AGENT=./agent ./scripts/dream.sh   the wrapper that reads a transcript on stdin
#
# The night happens in $MEM_OUT, a copy of the live store. Collect stages the
# copy's candidates as one run; apply/reject then deletes the copy.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .scratch

MEM="${MEM:-node bin/mem.js}"
SINCE="${1:-${SINCE:-$(date -u -d 'yesterday' +%Y-%m-%dT%H:%M:%SZ)}}"
MODE="${MODE:-single}"
PARALLEL="${PARALLEL:-4}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-600}"
WORK=.scratch/dream
TRANSCRIPTS="$WORK/transcripts"
CANDIDATES="$WORK/candidates"

mem() { $MEM "$@"; }

mkdir -p "$WORK"
export MEM_OUT="${MEM_OUT:-$WORK/night.db}"

mem dream fork --out "$MEM_OUT" > "$WORK/fork.json"
echo "fork: $MEM_OUT"

if [ -z "${MEM_AGENT:-}" ]; then
  echo "MEM_AGENT unset; the copy is ready. inspect it, then:"
  echo "  $MEM dream collect $MEM_OUT"
  exit 0
fi

if [ "$MODE" = "single" ]; then
  mem dream --packet --since "$SINCE" > "$WORK/packet.json"
  echo "packet: $(wc -c < "$WORK/packet.json") bytes since $SINCE"
  timeout "$AGENT_TIMEOUT" $MEM_AGENT < "$WORK/packet.json" > "$WORK/candidates.json"
  mem dream propose --db "$MEM_OUT" "$WORK/candidates.json"
else
  rm -rf "$TRANSCRIPTS" "$CANDIDATES"
  mkdir -p "$TRANSCRIPTS" "$CANDIDATES"
  mem dream transcripts --dir "$TRANSCRIPTS" --since "$SINCE" > "$WORK/transcripts.json"

  mapfile -t jobs < <(node -e '
    const fs = require("fs")
    const listing = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    for (const item of listing.transcripts) console.log(`${item.session}\t${item.path}`)
  ' "$WORK/transcripts.json")

  echo "transcripts: ${#jobs[@]} since $SINCE"

  one() {
    local session="$1"
    local transcript="$2"
    local candidates="$CANDIDATES/$session.json"
    local log="$CANDIDATES/$session.log"

    if ! timeout "$AGENT_TIMEOUT" $MEM_AGENT < "$transcript" > "$candidates" 2> "$log"; then
      echo "agent failed: $session (see $log)" >&2
      return 0
    fi
    if ! mem dream propose --db "$MEM_OUT" --session "$session" "$candidates" >> "$log" 2>&1; then
      echo "propose failed: $session (see $log)" >&2
    fi
  }

  running=0
  for job in "${jobs[@]}"; do
    session="${job%%$'\t'*}"
    transcript="${job#*$'\t'}"
    one "$session" "$transcript" &
    running=$((running + 1))
    if [ "$running" -ge "$PARALLEL" ]; then
      wait -n || true
      running=$((running - 1))
    fi
  done
  wait
fi

mem dream collect "$MEM_OUT" > "$WORK/collected.json"
RUN=$(node -e '
  const fs = require("fs")
  console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runId)
' "$WORK/collected.json")

if [ "${APPLY:-1}" = "1" ]; then
  mem dream apply "$RUN"
  mem dream --auto
  mem stats
else
  echo "collected run $RUN; review it with: $MEM dream review $RUN"
fi
