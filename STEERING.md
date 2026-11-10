# Memory steering

One file per memory store: what is worth keeping, and what to drop.

## Keep

- Commands, paths, versions, and gotchas that cost a session time.
- The reproducing command and the exact error text.
- Decisions a future agent would otherwise reverse.
- Prevalence: how many sessions showed the same thing.

## Drop

- Scratch lint commands, formatter output, and one-off local experiments.
- Container or machine trivia that does not change how the project is built.
- Recaps of the prompt runner or the agent conversation.
- Restatements of what the code already makes obvious.
