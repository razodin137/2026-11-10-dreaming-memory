#!/usr/bin/env bash
# Run the split prompts in prompt/ one at a time, each in a
# fresh session, stopping at the first failure.
#
#   MODEL=ollama/deepseek-v4.1-flash:1017-cloud ./scripts/split-serial.sh
#   MODEL=... FROM=8 TO=8 ./scripts/split-serial.sh    # one step only
#   ONLY=11-state,07-remove,08-shell ./scripts/split-serial.sh   # explicit order
#   COMMIT=0 ./scripts/split-serial.sh                 # leave commits alone
#   CHECK_CMD='make test' ./scripts/split-serial.sh    # override the detected gate
#   CHECK_ONLY=1 ./scripts/split-serial.sh             # print the gates and exit
#   ALLOW_NO_CHECK=1 ./scripts/split-serial.sh         # run without a project check
#
# Canonical copy. Install it, never retype it:
#   install -m 755 ~/.config/opencode/scripts/split-serial.sh scripts/split-serial.sh
# Never edit the copy per project; use CHECK_CMD instead.
#
# No --continue and no --session: that is what makes every step a fresh agent.
# The tree must be clean before the loop starts, and every green step is
# committed, so a bad step is one `git revert` away.

set -uo pipefail

RUNNER_VERSION=2

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOGS="$ROOT/.scratch/split"
MODEL=${MODEL:-ollama/deepseek-v4.1-flash:1017-cloud}
FROM=${FROM:-1}
TO=${TO:-99}
COMMIT=${COMMIT:-1}
ONLY=${ONLY:-}
CHECK_CMD=${CHECK_CMD:-__detect__}
CHECK_ONLY=${CHECK_ONLY:-0}
ALLOW_NO_CHECK=${ALLOW_NO_CHECK:-0}

if [ "${1:-}" = "--version" ]; then
  printf 'split-serial %s\n' "$RUNNER_VERSION"
  exit 0
fi

mkdir -p "$LOGS"
cd "$ROOT" || exit 1

has_make_target() {
  make -n "$1" >/dev/null 2>&1
}

detect_check() {
  if [ "$CHECK_CMD" != "__detect__" ]; then
    printf '%s\n' "$CHECK_CMD"
  elif [ -f package.json ] && node -e \
      'process.exit(require("./package.json").scripts?.check ? 0 : 1)' 2>/dev/null; then
    printf 'npm run check\n'
  elif [ -f Makefile ]; then
    local check="" target
    for target in test lint; do
      if has_make_target "$target"; then
        check="${check:+$check && }make $target"
      fi
    done
    if [ -z "$check" ] && has_make_target check; then
      check="make check"
    fi
    printf '%s\n' "$check"
  elif [ -f go.mod ]; then
    printf 'go vet ./... && go test ./...\n'
  fi
}

detect_house() {
  if [ -f go.mod ]; then
    printf 'go vet ./...\n'
  elif [ -f package.json ] && node -e \
      'process.exit(require("./package.json").scripts?.lint ? 0 : 1)' 2>/dev/null; then
    printf 'npm run lint\n'
  elif [ -f Gemfile ] && [ -f .rubocop.yml ]; then
    printf 'bundle exec rubocop\n'
  fi
}

CHECK=$(detect_check)
HOUSE=$(detect_house)

if [ -z "$CHECK" ]; then
  echo "== no project check detected; set CHECK_CMD to gate each step" >&2
  if [ "$CHECK_ONLY" = "1" ] || [ "$ALLOW_NO_CHECK" != "1" ]; then
    exit 1
  fi
else
  echo "== check: $CHECK"
fi

if [ -n "$HOUSE" ]; then
  echo "== house: $HOUSE"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=normal -- . ':(exclude).scratch')" ]; then
  echo "== tree is dirty; commit it before starting" >&2
  exit 1
fi

shopt -s nullglob
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a files <<<"$ONLY"
  for i in "${!files[@]}"; do
    files[$i]="$ROOT/prompt/${files[$i]}.md"
  done
else
  files=("$ROOT"/prompt/*.md)
fi
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "== no prompts in $ROOT/prompt" >&2
  exit 1
fi

for path in "${files[@]}"; do
  name=$(basename "$path" .md)
  step=$((10#${name%%-*}))

  if [ -z "$ONLY" ]; then
    [ "$step" -lt "$FROM" ] && continue
    [ "$step" -gt "$TO" ] && continue
  fi

  if [ ! -f "$path" ]; then
    echo "== $name: no such prompt" >&2
    exit 1
  fi

  blocked="$LOGS/BLOCKED-$name"
  rm -f "$blocked"

  echo "== $name"
  opencode run -m "$MODEL" --auto --title "split $name" \
    "$(cat "$path")" 2>&1 | tee "$LOGS/$name.log"
  status=${PIPESTATUS[0]}

  if [ -f "$blocked" ]; then
    echo "== $name: blocked, $(cat "$blocked")" >&2
    exit 1
  fi

  if [ "$status" -ne 0 ]; then
    echo "== $name: opencode exited $status, stopping" >&2
    exit 1
  fi

  if [ -n "$CHECK" ] && ! eval "$CHECK" >"$LOGS/$name.check" 2>&1; then
    echo "== $name: check failed ($CHECK), see $LOGS/$name.check" >&2
    echo "== the work is uncommitted; fix it, then resume with FROM=$step (or ONLY=$name)" >&2
    exit 1
  fi

  if [ -n "$HOUSE" ] && ! eval "$HOUSE" >"$LOGS/$name.house" 2>&1; then
    echo "== $name: house-style check failed ($HOUSE), see $LOGS/$name.house" >&2
    echo "== the work is uncommitted; fix it, then resume with FROM=$step (or ONLY=$name)" >&2
    exit 1
  fi

  git diff --stat >"$LOGS/$name.diff"

  if [ "$COMMIT" = "1" ]; then
    git add -A -- . ':(exclude).scratch'
    if git diff --cached --quiet; then
      echo "== $name: no changes to commit" >&2
    else
      git commit -q -m "split: $name"
    fi
  fi
done

echo "== finished (runner $RUNNER_VERSION)"
