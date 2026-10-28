# Working with Claude and Codex in T3 Code

A guide for the owner. Claude (Opus 5.5) is the **Builder**: it writes the
spec, the plan and the code. Codex is the **Reviewer**: it checks each of those
and runs the full checks before anything is pushed. You approve every gate. The
rules both agents follow are in [`AGENTS.md`](../AGENTS.md).

## One-time setup

1. **Project:** in T3 Code, add the `travel_buddy_backend` folder and choose
   the `main` branch.
2. **Database:** start Docker Desktop, then run
   `docker start travel-buddy-postgres` (or add it as a project script).
3. **Project scripts (optional):** "Add project script" gives one-click
   buttons, for example:
   - Start database: `docker start travel-buddy-postgres`
   - Quick checks:
     `npm run format:check && npm run lint && npm run typecheck && npm test`
4. **GitHub CLI (recommended):** lets the agents open pull requests and read
   CI results. In a terminal run `winget install --id GitHub.cli -e`, then
   `gh auth login` and follow the prompts yourself. Never give a token to an
   agent.
5. **Access mode:** "Full access" lets an agent run commands, commit and push
   without asking you. If T3 Code offers a mode that asks before commands, use
   it for the Builder. Either way, `AGENTS.md` forbids pushing without your OK.

## For each item: two threads

Create two threads in the `travel_buddy_backend` project, both on
**Current checkout** (the same folder):

| Thread               | Model                             |
| -------------------- | --------------------------------- |
| `Item 12 · Builder`  | Claude Opus 5.5                   |
| `Item 12 · Reviewer` | a Codex model from the model list |

Run them **one at a time**: wait until one thread finishes before you send the
next message to the other. They share the same files, and only the Builder
edits code.

Replace `<N>`, `<title>` and `<slug>` below, for example `12`,
`Analytics events` and `item-12-analytics-events`.

### 1. Spec (Builder thread)

```text
Read AGENTS.md and docs/roadmap.md. We are starting item <N> (<title>).
Make sure main is up to date, create the item branch, and write
docs/work/<slug>/spec.md. Do not write code. Stop when the spec is ready.
```

### 2. Spec review (Reviewer thread)

```text
Read AGENTS.md. You are the Reviewer for item <N>. Review
docs/work/<slug>/spec.md against the PRD and the current code. Add your round
to docs/work/<slug>/review.md. Edit nothing else.
```

If the verdict is `CHANGES REQUESTED`, go back to the Builder:

```text
Read docs/work/<slug>/review.md. Answer every finding: fix it in spec.md or
explain why not, and write your reply under the round. Stop when done.
```

Then ask the Reviewer for the next round:

```text
Next round: check the Builder's replies and the updated spec.md, and add a new
round to review.md.
```

Stop after 3 rounds. If they still disagree, read both sides in `review.md` and
decide yourself.

**Your gate:** read `spec.md`. Check that it solves the right problem, the
"Decisions" section has your answers, and nothing in "Out of scope" is
something you actually want. Then tell the Builder:

```text
Spec approved. Write docs/work/<slug>/plan.md. No code yet.
```

### 3. Plan and plan review

Same loop as the spec, with `plan.md` instead of `spec.md`.

**Your gate:** check the list of files, whether there is a migration, and the
tests it will add. Then tell the Builder:

```text
Plan approved. Build it with tests and docs, run every check in AGENTS.md
"Checks" and save the full logs, then commit locally. Do not push.
```

### 4. Verify (Reviewer thread)

```text
Verify item <N>. Review the changes (git diff main...HEAD) against spec.md and
plan.md, run every check in AGENTS.md "Checks" yourself, and add a code review
round to review.md with each check's result.
```

If there are findings, send the Builder:

```text
Fix the code review findings in review.md, rerun the affected checks, commit,
and reply under the round.
```

Then ask the Reviewer for the next round, as before.

**Your gate:** the latest round says `Verdict: APPROVED` and lists every check
as passed. Then tell the Builder:

```text
Approved. Push the branch and open the pull request.
```

Without the GitHub CLI, the Builder pushes and you open the pull request from
the link `git push` prints (`.../pull/new/<branch>`).

### 5. CI and merge

Wait for the CI check on the pull request to go green. With the GitHub CLI you
can ask the Reviewer `Check CI for PR #<number> and report the result.` If it
fails, send the failure to the Builder to fix.

After you merge, tell the Builder:

```text
I merged PR #<number>. Confirm main contains it, switch to main, and delete the
item branch.
```

## When things go wrong

- **The agents disagree:** after 3 rounds you decide. Ask either agent to
  explain its side in plain words if it is unclear.
- **A test fails once and then passes:** see "Known flaky tests" in
  `AGENTS.md`. A failure that repeats is real.
- **An agent starts something you did not ask for:** stop it and point it to
  `AGENTS.md` rule 1.
- **You want to change a rule:** edit `AGENTS.md` (or ask an agent to, as its
  own small pull request). Both agents read it at the start of every thread.
