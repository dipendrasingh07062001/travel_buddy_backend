# Plan: server-startup test deadline

Spec approved by the owner on 2026-11-07, with D1 at the recommended 120 s.

## Files to change

### `test/server-startup.test.ts`

- `const childDeadline = 45_000;` becomes `const childDeadline = 120_000;`.
- The `beforeAll` timeout argument `60_000` becomes `childDeadline + 30_000`.
- The comment above the hook's closing line is replaced with one that matches
  the new evidence, for example:

  ```ts
  // Six starts run together. In full unit runs each took up to 35 s on a
  // 4-core machine, and a busier machine went past 45 s, so each child gets
  // 120 s. The extra hook time lets a slow child be reported by the timedOut
  // assertion; if killing a child stalls, the hook timeout fails instead.
  }, childDeadline + 30_000);
  ```

Nothing else in the file changes: not the cases, `childEnvironment`,
`startServer`, `afterAll`, `expectStoppedCleanly` or any assertion.

No other source, test or config file changes. `vitest.config.ts` keeps its
30 s `hookTimeout`; this file's hook already overrides it.

## Migration

None.

## Tests and checks

The file's own tests are the test; no new test is added.

1. Run the file alone: `npx vitest run test/server-startup.test.ts`, saved to
   `startup-alone.log`. Expect 6/6.
2. Forced-deadline check of the kill path (temporary, not committed): set
   `childDeadline` to `1`, run the file alone and save to
   `startup-forced-deadline.log`. Expect all six cases to fail on
   `expect(result.timedOut).toBe(false)`, with the hook finishing normally,
   not timing out. Restore `120_000` and confirm with `git diff` that only
   the intended lines differ.
3. All checks in AGENTS.md order, with full output in `*.log` files:
   format:check, lint, db:validate, db:migrate:deploy, typecheck, `npm test`
   (`unit.log`), `npm run test:integration` (`integration.log`), build and
   `npm audit --audit-level=high`. Skip `npm ci`, because the package files
   are unchanged. Confirm first that the database container is running and no
   dev server is running. Run unit and integration one after the other.

Rate limits and test isolation: not affected (no app routes, no database).

## Docs

- `docs/roadmap.md`, "Found later" table: add the row
  `| Server-startup test deadline (C2-1 on admin user search) | In review |`.
- `docs/backend-remaining-work.md`:
  - "Current milestone": replace it with a short entry for this fix.
  - "Already implemented": add the same entry, and move the current
    duplicate-submissions (PR #61) milestone text there with its PR number,
    as admin search did.
- `README.md`: no change; it does not mention this test or its timeouts.

## Risks

- **A real hang is reported later** (up to 120 s instead of 45 s). This
  delays the failure but does not hide it. Accepted in D1.
- **The unit suite can take longer when something is slow.** On a healthy run
  nothing changes, because the children finish as before.
- **Contention could exceed 120 s** on an even busier machine. If it does,
  the failure remains the clear `timedOut` assertion and needs a new
  investigation, not a further raise by default.
- **Killing a child could itself stall.** Then the hook timeout (150 s)
  fails the run instead of the `timedOut` assertion. It is still a failure,
  not a pass.
- **No breaking changes**: test file only.

## Commit

One local commit on `fix/server-startup-deadline`:
`fix(tests): give server-startup children more time under load`, carrying
the test change, docs and `docs/work/server-startup-deadline/`. Codex
verifies, then the owner OKs the push.

## Changes from the plan

None to the code: the test change is the one planned, with the comment as
written above. One result to note: the forced-deadline check (1 ms) failed
all six cases at `expectStoppedCleanly`'s `timedOut` assertion, with no hook
timeout (`startup-forced-deadline.log`), and the value was restored to
`120_000` before the final checks.
