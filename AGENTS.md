# Agent instructions

Shared rules for every AI agent working in this repository (Claude reads them
through `CLAUDE.md`, Codex reads this file directly). The human owner decides;
agents propose, build, review and verify.

## Ground rules

1. **One item at a time.** Work only on the roadmap item the owner named.
   Anything else you notice goes in your report as a suggestion, not a change.
2. **Explain before code.** No code until the owner approves the spec and the
   plan (see the workflow below).
3. **Never push, open a pull request or merge without the owner saying so in
   the chat for that item.** Committing locally on the item's branch is fine.
4. **Be honest.** Report failures, skipped steps and flaky results exactly as
   they happened, with the evidence. Never claim a check passed if you did not
   run it.
5. **No secrets.** Never print, commit or paste `.env`, keys, tokens or
   service-account files. `.env` stays out of git.
6. **One agent at a time in this folder.** Do not edit files while the other
   agent is working. The owner runs the agents one after another.

## Roles

| Role         | Default agent   | Does                                                                     | Never                                                |
| ------------ | --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Owner**    | the human       | Chooses the item, approves each gate, pushes or allows pushing, merges   |                                                      |
| **Builder**  | Claude Opus 5.5 | Writes the spec and plan, answers review findings, writes code and tests | Pushes, opens PRs or merges without the owner's OK   |
| **Reviewer** | Codex           | Reviews the spec, plan and code; runs the full checks; gives a verdict   | Edits anything except the item's `review.md`; pushes |

If the owner swaps the roles for an item, follow the owner.

## Workflow for each item

Work files live in `docs/work/<item-slug>/` on the item's branch and are
committed with the item, so the pull request carries its own reasoning.

| Stage          | Who      | Output                                                      | Gate                                |
| -------------- | -------- | ----------------------------------------------------------- | ----------------------------------- |
| 1. Start       | Builder  | Branch `feature/<item-slug>` (or `fix/`) from latest `main` |                                     |
| 2. Spec        | Builder  | `spec.md`                                                   |                                     |
| 3. Spec review | Reviewer | Round in `review.md`; Builder revises until `APPROVED`      | **Owner approves the spec**         |
| 4. Plan        | Builder  | `plan.md`                                                   |                                     |
| 5. Plan review | Reviewer | Round in `review.md`; Builder revises until `APPROVED`      | **Owner approves the plan**         |
| 6. Build       | Builder  | Code, tests, docs; all checks run; one local commit         |                                     |
| 7. Verify      | Reviewer | Code review and full checks in `review.md`                  | `APPROVED`, then **owner OKs push** |
| 8. Push and PR | Builder  | Push, pull request (only after the owner's OK)              | GitHub CI green                     |
| 9. After merge | Builder  | Confirm `main` contains the commit, delete the branch       |                                     |

**Review loops end.** At most 3 rounds per review stage. If the Reviewer still
has blocking findings after round 3, both agents write a short summary of the
disagreement in `review.md` and the owner decides.

### `spec.md` (what and why)

- Item number, title and PRD sections.
- Problem: what is missing today, checked against the code.
- Proposed behaviour: API changes (endpoints, request and response fields,
  error codes), who can see what, edge cases.
- Data: migrations, constraints, backfill (or why none).
- Privacy, safety and abuse considerations.
- Out of scope.
- Acceptance criteria as a checklist the Reviewer can test.
- Decisions the owner must make, each with a recommended default.

### `plan.md` (how)

- Files to change and why; new helpers and where they live.
- Migration name and SQL outline.
- Tests to add or change (unit and integration), including rate limits and
  test isolation.
- Docs to update.
- Risks, breaking changes and how they are handled.
- After building, add "Changes from the plan" with anything that differed.

### `review.md` (Reviewer only, Builder replies inline)

Each round starts with a heading and a verdict line:

```md
## Spec review, round 1

Verdict: CHANGES REQUESTED

- S1-1 [blocking] What is wrong, where (file:line or section), why it matters,
  and what would fix it.
- S1-2 [suggestion] ...

Builder reply: S1-1 fixed in spec.md "Data". S1-2 declined because ...
```

Use `S` for spec, `P` for plan and `C` for code findings. `blocking` means the
item must not go ahead; `suggestion` is optional. Approve when nothing blocking
remains (`Verdict: APPROVED`). For the code stage, also record every check you
ran, with its result and the log file name.

## Checks (same as CI)

Run these in order; the GitHub workflow in `.github/workflows/ci.yml` does the
same. The database must be running first (`docker start travel-buddy-postgres`).

```sh
npm ci                     # only when package.json or package-lock.json changed
npm run format:check
npm run lint
npm run db:validate
npm run db:migrate:deploy
npm run typecheck
npm test
npm run test:integration   # several minutes; save the full output to a *.log file
npm run build
npm audit --audit-level=high
```

Save complete test output to a `*.log` file in the repository root (ignored by
git), not just the summary, so any failure can be diagnosed.

**Known flaky tests on a busy machine:** an integration file can fail in
`beforeAll` with "Hook timed out in 15000ms", and `test/rate-limit.test.ts` can
time out. If that happens, run the failed file alone, then the full suite once
more, and report both results. A failure that repeats is a real failure.

## Project facts

- **PRD:** `Travel_Buddy_Web_Platform_PRD_v2-1.docx`, kept outside the
  repository (currently in the owner's Downloads folder). Ask the owner if you
  cannot read it; cite PRD sections as `PRD §7.2`.
- **Stack:** Node 24, TypeScript (strict, `exactOptionalPropertyTypes`),
  Fastify 5, Prisma 7 with PostgreSQL 17, Vitest, Firebase auth, Cloudflare R2.
  API docs at `/docs`.
- **Database:** Docker container `travel-buddy-postgres` (`compose.yaml`).
  Connection settings come from `.env` (see `.env.example`).
- **Migrations:** edit `prisma/schema.prisma`, run `npx prisma format`, then
  generate SQL with
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  into `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`. Add a short
  comment and any CHECK constraints by hand. Then `npx prisma migrate deploy`
  and `npx prisma generate`. Running the diff again must print an empty
  migration.
- **Errors:** `AppError(status, 'CODE', message)`; clients rely on the codes.
- **Routes:** Fastify JSON schemas. Response schemas drop unknown fields, so add
  every new response field to the schema.
- **Privacy:** public text goes through `requireSafePublicText` and
  `publicText`. Notifications have fixed titles; never copy user text into them.
- **Tests:** integration tests create their own users and trips with
  `randomUUID()` and delete them in `afterAll`. Some routes are rate-limited per
  user (recording a settlement 10 per minute, creating an expense 20 per
  minute), so give a new test its own user or trip when needed. Switch
  environment settings with `vi.mock('../src/config/env.js', ...)`.
- **Style:** match the surrounding code, its naming and its comment density.
  Short comments explain why, not what.
- **Docs for every item:** the relevant `README.md` section,
  `docs/backend-remaining-work.md` (current milestone and "Already
  implemented") and the item's status in `docs/roadmap.md`.
- **Git:** branch per item from `main`; commit messages like
  `feat(expenses): ...` or `fix(trips): ...`. After a merge, confirm with
  `git merge-base --is-ancestor <commit> origin/main` before starting the next
  item; do not trust a "merged" message alone.
- **Pull requests:** the GitHub CLI (`gh`) is not installed yet, so the owner
  opens pull requests on GitHub unless they install it.

## Where we are

The numbered roadmap and the status of every item are in
[`docs/roadmap.md`](docs/roadmap.md). The detailed engineering checklist is in
[`docs/backend-remaining-work.md`](docs/backend-remaining-work.md). How the
owner drives the agents in T3 Code is in
[`docs/ai-workflow.md`](docs/ai-workflow.md).
