4. Run the night as a fan-out, not one giant packet
One agent fed a packet of every session doesn't scale: context grows with the day, one malformed JSON blob kills the run, and nothing happens in parallel. Split the night instead:

- mem dream fork — copy the live store to $MEM_OUT, print the path, leave live memory alone. A night is discardable: delete the copy and nothing happened.
- an orchestrator (scripts/dream.sh) writes one transcript per undistilled session, then spawns one subagent per transcript, each pointed at its own session and at $MEM_OUT. A subagent proposes candidates only; it never edits notes. Its writes go through the same fingerprint dedupe and version check as remember, into the copy's staged table.
- mem dream collect $MEM_OUT — pulls those staged rows into $MEM as one run and leaves the copy for inspection. Review and apply stay the only way into live memory: the copy is never promoted wholesale, and $MEM_OUT is deleted once the run is applied or rejected.

The single-agent path stays behind the same command for a quiet night. A subagent that hangs or emits rubbish costs one session, not the night: collect skips candidates it cannot attribute to a session, and the run is rejected like any other.

Tests that need no model: two subagents proposing the same fact collapse to one note, a stale candidate loses to a newer version, and collect run twice against the same $MEM_OUT stages the same run. Rehearse against a pack of canned transcripts before this goes near cron.
