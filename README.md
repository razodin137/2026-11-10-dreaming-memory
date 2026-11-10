# mem

Collective SQLite memory for agent sessions, with a nightly consolidation ("dream") cycle.
Zero runtime dependencies — built on `node:sqlite`.

```
mem.db
├── projects      one row per try directory, registered lazily on first session
├── notes         the memory itself (project-scoped or global)
├── note_hits     who recalled what, when — drives decay and promotion
├── sessions      one row per agent session, carrying its diary
├── staged        dream output, applied deterministically
├── note_revisions  the previous version of every note that changed
└── dream_runs    an audit log of every night
```

## Quick start

```sh
node bin/mem.js init
node bin/mem.js session start --id s-001
node bin/mem.js remember --kind gotcha --body "bin/setup needs redis on 6379"
node bin/mem.js recall --limit 5
node bin/mem.js materialize
```

`MEMORY_DB` overrides the database path (default `./memory.db`).

## The model

**Notes are scoped.** `project` notes belong to one directory; `global` notes are shared.
Retrieval always reads *this project + global*, never another project's notes.

**Notes carry provenance and confidence.** `body` must be checkable — a path, a command,
a version, a specific gotcha. "Be careful with migrations" is a failed note.

**Usage decides survival.** Every `recall` records a hit. `mem decay` lowers confidence on
notes that stop being retrieved and retires them below 0.05. `mem promote` lifts a note to
global only once the same claim has been hit in two different projects.

**Writes are staged, then applied.** The dream step emits candidates; `apply` executes them
as deterministic `insert | merge | update | retire` operations, deduped by a normalized
fingerprint. A bad night is one transaction away from being reverted.

`mem dream stage FILE` writes the proposals to `staged` and stops there — live memory is
untouched until a run is applied. Each proposal keeps its `examples` (session ids and
file:line excerpts) and `prevalence` alongside the free-text reason, and apply preserves
both in the dream run's summary.

`mem dream review RUN` prints what that run would do, one proposal at a time: the operation,
project, kind, note text, confidence, the note it would merge into or replace, and the
evidence and prevalence behind it. Review is read-only; nothing is applied.

`mem dream apply RUN` commits the proposals in that run. `mem dream reject RUN` throws the
batch away instead; live memory stays untouched. A run can only be rejected while none of
its proposals have been applied.

**Every changed note leaves its previous self behind.** Before an update or promotion
changes a note's body or scope, the old row is copied into `note_revisions` with the dream
run that caused it. `mem revisions --note 42` shows what a note said before each change.

## The nightly cycle

```sh
# 1. what was learned today, and what is already known
mem dream --packet --since 2026-11-09T00:00:00Z > .scratch/packet.json

# 2. an agent reads the packet and writes candidates (your model, your prompt)
agent-of-choice < .scratch/packet.json > .scratch/candidates.json

# 3. deterministic apply + housekeeping
mem dream --apply .scratch/candidates.json
mem dream --auto
```

`mem dream --auto` promotes cross-project notes, decays unused ones, and archives
directories untouched for 30 days.

`--apply` is the straight-through path cron uses: stage and commit in one invocation. For
an interactive night, stop after staging and accept or reject the run yourself:

```sh
mem dream stage .scratch/candidates.json   # prints the run id
mem dream review 7
mem dream apply 7                          # commit it
mem dream reject 7                         # or throw it away
```

```cron
0 3 * * * cd ~/src/dreaming-memory && ./scripts/dream.sh >> .scratch/dream.log 2>&1
```

`scripts/dream.sh` takes the agent command from `MEM_AGENT` (a wrapper that reads the
packet on stdin and prints candidate JSON). Without it, the script stops after building
the packet so you can inspect it.

## Hooking up `try`

`try` prints `mkdir -p …; cd …` for the shell to evaluate, so it never creates the
directory itself. Two options, in order of preference:

1. **Lazy registration (default, no patch).** The first `mem session start` or `remember`
   in a new directory inserts the project row. Any directory gets memory, not just tries.
2. **Explicit patch.** Append `&& mem register "$path"` to `script_mkdir_cd` in
   `/usr/lib/tobi-try/try.rb`. Purely for tidiness — the DB is correct either way.

## House style

Configs are read from the local reference clone; nothing is re-cloned per directory.
This project is JS-only, so `npm run lint` runs `@37signals/eslint-config` with Node
globals swapped in for the browser globals the upstream config assumes.

## Moving it later

The DB is a single file plus its WAL siblings. Point `MEMORY_DB` at a fixed XDG path
(`~/.local/share/mem/memory.db`) when you are ready — nothing else in the code assumes a
location.
