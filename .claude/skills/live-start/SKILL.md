---
name: live-start
description: Start fresh on the live presentation service without rereading the codebase, or hand off before clearing the session. Use at the start of a new prompt on this repo, when the user says to start over or pick up where things were left, or with the argument "handoff" to save state before /clear.
argument-hint: "[task | handoff]"
---

# Start fresh on `live`

Arguments: $ARGUMENTS

`CLAUDE.md` is already loaded. Treat it as the map, and don't reread the repository.

## If the argument is `handoff`

1. Run `git status -sb` and `git log --oneline -5`.
2. Rewrite "Current state" in `CLAUDE.md` so it's short and true. Remove what's resolved. Add open
   problems, unverified work and anything waiting on the owner.
3. Add a lasting lesson to "Caveats" or "Things that must stay true" only if it would catch out a future
   session. Don't record what happened in the session.
4. Reply with what changed, then tell the owner to run `/clear` and `/live-start <next task>`.

Leave git alone unless the owner asks for a commit.

## Otherwise

1. Check reality against "Current state":

   ```sh
   git fetch -q origin; git status -sb; git log --oneline -5
   ```

2. Flag anything in "Current state" that no longer matches. Fix it in `CLAUDE.md` once you've confirmed it.
3. If the argument names a task, read only the files that "Where things are" gives for it, then do the
   task. Use `grep` and line ranges on large files. Never read `tests/fixtures/pb016-cv05.html` whole.
4. If there's no task, summarise the state and open items in a few lines and ask what's next.
5. Before finishing, run typecheck and unit tests, plus the e2e specs the change touches. Run the
   full e2e suite and WebKit for protocol, overlay or controls changes.

An open item in "Current state" is not a task unless the owner asks for it or it blocks the current one.
