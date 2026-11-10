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
├── run_sessions  which sessions a run was distilled from
├── note_revisions  the previous version of every note that changed
└── dream_runs    an audit log of every night
```

## Quick start

```sh
node bin/mem.js init
node bin/mem.js session start --id s-001
node bin/mem.js remember --topic deploy --kind gotcha --body "bin/setup needs redis on 6379"
node bin/mem.js recall --limit 5
node bin/mem.js sync
```

`MEMORY_DB` overrides the database path (default `./memory.db`).
`MEMORY_DIR` overrides the topic-file directory (default `./memory`).

## One store, two loops

The readable store is a directory of subject files, one per thing a future agent would
search for:

```text
memory/
├── README.md          index
├── deploy.md          "how this ships"
├── flaky-tests.md     "what fails intermittently"
└── repo-layout.md     "where things live"
```

Every entry keeps its ledger id in an HTML comment, so the markdown and the database stay
the same note:

```markdown
- <!-- mem {"id":12,"kind":"gotcha","confidence":0.72,...} --> `bin/deploy` needs `RAILS_ENV`.
  - Repro: `bin/setup`
  - Seen: 7 of 23 sessions (s-001, s-004)
```

**Real-time.** `mem remember` writes the note to the ledger and to the file for its
`--topic`, through one helper (`recordNote`) that takes a per-file lock and keeps the note
id. That helper is the only writer, so a nightly rewrite and a live edit queue behind the
same lock instead of overwriting each other.

**Batch.** Dreaming reads the day's transcripts and the current files. It has three verbs,
and they are real:

- **verify** — stat every backticked path, read the version claimed for a dependency, and
  re-run read-only commands. `--execute` also runs any other safe command. True claims
  keep their place and can gain confidence. False claims are rewritten (when the
  correction is known) or dropped, with the reason and a revision behind them.
- **organize** — split a topic that grew past `--split-at`, merge topic names that
  converged (`deploy`/`deploys`), move a claim to the subject it actually names, and
  cross-link related files.
- **enrich** — add what the transcripts taught: the reproducing command, prevalence
  ("3 of 12 sessions"), and the sessions that showed it.

Only destructive work waits: a verify rewrite/drop, or any other change that removes or
replaces a claim, is staged and reviewed exactly like a dream run. Splits, moves,
cross-links, and enrichment land automatically. `mem dream revert RUN` restores the
previous note for every change the run made.

`mem sync` rebuilds the topic files and the index from the ledger; `mem topics` lists them.

## The model

**Notes are scoped.** `project` notes belong to one directory; `global` notes are shared.
Retrieval always reads *this project + global*, never another project's notes. Each note
also carries a `topic`, the subject file it belongs in.

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

# 2. an agent reads the packet, the transcripts, and the current topic files
agent-of-choice < .scratch/packet.json > .scratch/candidates.json

# 3. deterministic apply, then the three verbs + housekeeping
mem dream --apply .scratch/candidates.json
mem dream --auto
```

`mem dream --auto` runs enrich, organize, and verify for every active project (or the one
named with `--path`), then promotes cross-project notes, decays unused ones, and archives
directories untouched for 30 days. Anything verify would drop or rewrite is staged:
`--auto` does not apply those unattended.

Each verb is also a command of its own:

```sh
mem dream verify [--execute] [--dir memory]
mem dream organize [--split-at 20] [--stage]
mem dream enrich [--since 2026-11-09T00:00:00Z]
```

`--apply` is the straight-through path cron uses: stage and commit in one invocation. For
an interactive night, stop after staging and accept or reject the run yourself:

```sh
mem dream stage .scratch/candidates.json   # prints the run id
mem dream review 7
mem dream apply 7                          # commit it
mem dream reject 7                         # or throw it away
mem dream revert 7                         # undo an applied run
```

### Fan-out nights

One agent fed every session does not scale. `scripts/dream.sh` forks the live store,
writes one transcript per undistilled session, and runs one agent per transcript in
parallel. Each agent is pointed at its own session and at the copy; it proposes
candidates only, never edits notes:

```sh
mem dream fork --path                  # copies the live store to $MEM_OUT
mem dream transcripts --dir .scratch/dream/transcripts --since 2026-11-09T00:00:00Z
MEM_AGENT=./agent mem dream propose --db "$MEM_OUT" --session s-001 .scratch/dream/candidates/s-001.json
mem dream collect "$MEM_OUT"           # stages the copy's rows as one run
```

`collect` merges duplicate facts across agents, drops a stale update when a later
session proposes a newer one, and skips any candidate it cannot attribute to a session.
It also records the copy's `fork_id`, so collecting the same `$MEM_OUT` twice returns
the same run instead of staging it again.

Review and apply are still the only ways into live memory. The copy is never promoted
wholesale: `mem dream apply RUN` and `mem dream reject RUN` both delete `$MEM_OUT` when
they finish with a run. A night that goes wrong is one deleted file away from never
having happened.

The fan-out defaults to one agent per session, `PARALLEL=4`. For a quiet night,
`MODE=single ./scripts/dream.sh` sends one packet to one agent; its candidates must set
`session` (or be staged with `--session`) so `collect` can attribute them. `APPLY=0`
stops after collect so you can review the run first.

```cron
0 3 * * * cd ~/src/dreaming-memory && ./scripts/dream.sh >> .scratch/dream.log 2>&1
```

`scripts/dream.sh` takes the agent command from `MEM_AGENT` (a wrapper that reads one
transcript on stdin and prints candidate JSON). Without it, the script forks the store
and stops so you can inspect the copy.

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
