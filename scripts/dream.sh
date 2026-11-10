#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .scratch

MEM="${MEM:-node bin/mem.js}"
SINCE="${1:-$(date -u -d 'yesterday' +%Y-%m-%dT%H:%M:%SZ)}"

$MEM dream --packet --since "$SINCE" > .scratch/packet.json
echo "packet: $(wc -c < .scratch/packet.json) bytes since $SINCE"

if [ -z "${MEM_AGENT:-}" ]; then
  echo "MEM_AGENT unset; stopping after packet. inspect .scratch/packet.json"
  exit 0
fi

$MEM_AGENT < .scratch/packet.json > .scratch/candidates.json
$MEM dream --apply .scratch/candidates.json
$MEM dream --auto
$MEM stats
