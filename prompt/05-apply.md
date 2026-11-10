3. Split "dream" into stage, review, then apply
Right now mem dream --apply file.json stages and commits in one motion — the model's output lands in live memory with nobody looking. The new shape is  separate acts:

- mem dream apply <run> — commits what was reviewed. Plus mem dream reject <run> to throw the batch away.

Cron keeps the straight-through path (stage then apply in one invocation, no prompt), but the interactive path gets the accept/reject step she described. Because revisions now exist, apply also becomes undoing a run feasible.
