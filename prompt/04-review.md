3. Split "dream" into stage, review, then apply
Right now mem dream --apply file.json stages and commits in one motion — the model's output lands in live memory with nobody looking. The new shape is three separate acts:

- mem dream review <run> — prints a human-readable diff: for each proposal, what operation it is, which project, the note text, the confidence, which existing note it merges into, the evidence and prevalence. Nothing is applied.
