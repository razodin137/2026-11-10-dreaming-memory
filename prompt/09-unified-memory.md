5. One store, two loops
Two things touch memory: an agent during a session, and the batch between sessions. Today the batch writes a projection (MEMORY.md) that agents never write back, so there is one store and one loop. Copy Anthropic's shape: a team-memory directory of topic files — deploy.md, flaky-tests.md, repo-layout.md — one per subject a future agent would search for, read and written by both loops.

- Real-time: an agent recording a fact puts it in the file for its subject, through a single helper that takes the file lock and keeps the note id. That helper is the only writer, so a nightly rewrite and a live edit cannot overwrite each other silently.
- Batch: dreaming reads the day's transcripts and the current files, and does three jobs. Verify — every claim here is checkable by construction, so re-run the command, stat the path, read the version: still true keeps it (and can raise confidence), false rewrites or drops it with the reason and a revision behind it. Organize — split a file that grew unwieldy, merge files that converged, move a claim to where it will actually be looked for, cross-link related claims. Enrich — add what the transcripts taught: the reproducing command, prevalence, the session that showed it.

Nothing destructive goes through unattended: a run that drops a claim or rewrites a shared file stages the diff and waits for review, the same gate as dream apply. Everything else lands automatically.

Keep the existing ledger (notes, note_hits, note_revisions) underneath as the audit trail, so a bad night is still one revert away. Copying the shape first is fine; simplify once both loops actually run — the goal now is one store, two writers, and the three verbs real rather than implied.
