# Item 28 plan: Hosted Firebase credentials

Follows the approved spec with D1 (cherry-pick PR #44's commit onto this branch,
then close PR #44) and D2 (startup check).

## Steps

1. **Bring PR #44 over.** `git cherry-pick 14aa101` onto
   `feature/item-28-firebase-hosted-credentials`. A test merge onto `main`
   showed no conflicts. Keep `main`'s later `env.ts` changes (the exported
   schema and the profile-photo setting and its R2 rule).
2. **Credential parsing in one place** (`src/modules/auth/firebase-app.ts`):
   - New `parseServiceAccount(secret, projectId)` returns
     `{ projectId, clientEmail, privateKey }` or throws a
     `FirebaseCredentialError` (a small class in the same file) whose message
     is one of these fixed texts, with no `cause`:
     - `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.`
     - `FIREBASE_SERVICE_ACCOUNT_JSON is not a service account (type, project_id, client_email and private_key are required).`
     - `FIREBASE_SERVICE_ACCOUNT_JSON project_id does not match FIREBASE_PROJECT_ID.`
     - `FIREBASE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM private key.`
   - The key check uses `createPrivateKey()` from `node:crypto`, offline. Each
     step runs in its own `try` so the original error (which can quote the key)
     is dropped.
   - `firebaseApp()` uses `parseServiceAccount` and keeps PR #44's request-time
     behaviour: any failure becomes the generic
     `503 AUTHENTICATION_UNAVAILABLE`, with no fallback to
     `applicationDefault()`.
   - New exported `checkFirebaseCredentials()`: does nothing when the setting
     is unset (or `FIREBASE_PROJECT_ID` is unset, which already disables
     authentication); otherwise calls `parseServiceAccount` and lets the fixed
     error through.
3. **Startup** (`src/server.ts`): call `checkFirebaseCredentials()` as the
   first line inside the existing startup `try`, before `app.listen` and
   before any worker starts. A failure reaches the existing
   `app.log.fatal({ err }, 'API failed to start')`, then the database
   disconnect and `process.exit(1)`. The logged error carries only the fixed
   message.
4. **Docs:** update `docs/firebase-hosted-credentials.md` (startup check, what
   it cannot catch, the Railway steps), README "Firebase" paragraph,
   `.env.example`, `docs/backend-setup-checklist.md`, `docs/roadmap.md`
   (item 28 done, and "Status recorded") and `docs/backend-remaining-work.md`
   (item 28 becomes the "Current milestone"; the item 39 entry moves to the
   top of "Already implemented").
5. **Checks** (spec criterion 8). Start the database first
   (`docker start travel-buddy-postgres`) and confirm no dev server for this
   folder is running. Then run every check in `AGENTS.md` order, saving full
   output to repository-root `*.log` files named `item28-<check>.log`:
   `format:check`, `lint`, `db:validate`, `db:migrate:deploy`, `typecheck`,
   `npm test -- --reporter=verbose`, `test:integration`, `build`,
   `npm audit --audit-level=high`. `npm ci` only if `package.json` or
   `package-lock.json` changed (not expected). A timeout counts as a failure:
   rerun the failed file alone once, report both results and investigate.
6. **Commit** once, locally, keeping PR #44's commit author through the
   cherry-pick and adding this item's work on top in the same branch (one
   commit for the cherry-pick, one for this item). No push.

## Tests

- **`test/firebase-app.test.ts`** (from PR #44, adapted). The PR's fake key
  (`-----BEGIN PRIVATE KEY-----` around a marker) does not parse, so valid
  cases now use a real throwaway RSA key made with `generateKeyPairSync` in the
  test. The PR's cases stay: ADC when unset, only three fields forwarded, the
  app reused, project ID required, SDK errors sanitized, and a fresh token check
  returns 503 with a bad secret. New cases: each `parseServiceAccount` failure
  gives its fixed message, has no `cause`, and its `inspect()` output does not
  contain the marker; `checkFirebaseCredentials()` passes when the setting is
  unset and with the valid synthetic key.
- **`test/server-startup.test.ts`** (new). It runs the real entry point
  in child processes: `spawn(process.execPath, ['--import', 'tsx',
'src/server.ts'])` with an argument array and no shell.
  - **Controlled environment.** Each child gets a fresh environment built from
    scratch, not `process.env`: only the path variable (read
    case-insensitively, since Windows usually names it `Path`) and `SystemRoot`
    on Windows, which Node needs. Nothing else is inherited, including
    `NODE_OPTIONS` and any `DOTENV_*` option. It sets only `NODE_ENV=test`, `LOG_LEVEL=info`, `PORT=3999` (valid;
    every case fails before binding it), a synthetic
    `DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic`,
    `PUSH_NOTIFICATIONS_ENABLED=false`, `FIREBASE_PROJECT_ID=travel-buddy-test`
    and the case's `FIREBASE_SERVICE_ACCOUNT_JSON`. `DOTENV_CONFIG_PATH` points
    to an empty file in a temporary directory outside the repository, so the
    checkout's `.env` is never loaded and no developer setting can change the
    path taken.
  - **Fatal-startup path** (`server.ts`): invalid JSON, wrong `type`, missing
    `client_email`, different `project_id`, unparseable `private_key`.
    Expected: exit code 1, the case's fixed message and `API failed to start`
    in the output, no "Server listening" line.
  - **Environment-error path** (`env.ts`): a value over 65 536 characters that
    contains the marker. Expected: exit code 1, "Invalid environment
    configuration", and no `API failed to start`.
  - Every case: the marker appears in neither stdout nor stderr.
  - **Bounded lifecycle.** All children start together, asynchronously, in
    `beforeAll`. Each has a 45 s deadline; a child that is still running then
    is killed and its case fails as a timeout, and a spawn error or an exit by
    signal also fails the case. `afterAll` kills and waits for any child still
    running, so none outlive the file. Each `it` only checks its saved result,
    so test bodies stay well within 5 s.
  - **Hook limit.** The Reviewer measured a cold real start at about 13 s, and
    six start together on a 4-core machine, so this one `beforeAll` sets an
    explicit 60 s limit (`beforeAll(fn, 60_000)`) with a comment saying why,
    instead of the 30 s unit default. Only this file is affected.
  - The suite needs no database: every case stops before anything connects.
    Unset and valid credentials are tested through `checkFirebaseCredentials()`
    in the unit file, not by starting the full server, which would connect.

No rate-limited routes are touched; no integration tests change.

## Risks

- **`createPrivateKey` may accept a key Google rejects** (or the reverse for an
  unusual key type). Google's service-account keys are standard RSA PEM, which
  it parses. A revoked or deleted key passes the check and fails at the first
  sign-in with the generic 503; the owner's live sign-in after deploying
  catches that (spec "Limit").
- **Child-process tests are slower** (a few seconds total). They are limited to
  one file and start in parallel.
- **No change for anyone without the new setting:** local key files and cloud
  identities behave as on `main`.

## Changes from the plan

Built 2026-10-29. The code follows the plan. Differences and results:

- **Cherry-pick:** `14aa101` applied cleanly as `92cbd2f`, author kept.
- **PR #44's fixture key** was fake PEM text, which the new key check rejects,
  so 2 of its tests failed until the valid cases used a real throwaway key
  generated in the test (`generateKeyPairSync`). The fake text is kept as the
  "unparseable key" case.
- **Startup test as planned.** The minimal child environment (path and
  `SystemRoot` only) worked on Windows with no extra variables. All 6 cases
  pass in about 23 s, including the 45 s child deadline and 60 s hook.
- **Mutation check:** with the `checkFirebaseCredentials()` call removed from
  `src/server.ts`, the 5 credential cases fail and the environment case still
  passes (`item28-startup-mutation.log`). The file was restored.
- **Dev server:** an `npm run dev` server for this folder was running again
  before the checks. With the owner's OK it was stopped first, and no other
  database sessions remained.
- **Commit layout:** two commits, as the owner approved: `92cbd2f` (PR #44)
  and this item's commit on top.

Checks, all exit 0, logs in the repository root:

| Check                                 | Result                          | Log                                                                    |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `npm ci`                              | Not needed (no package changes) | none                                                                   |
| `format:check`, `lint`, `db:validate` | Pass                            | `item28-format-check.log`, `item28-lint.log`, `item28-db-validate.log` |
| `db:migrate:deploy`                   | Pass, no pending                | `item28-db-migrate-deploy.log`                                         |
| `typecheck`                           | Pass                            | `item28-typecheck.log`                                                 |
| `npm test -- --reporter=verbose`      | 31 files, 489 tests pass        | `item28-unit.log`                                                      |
| `test:integration`                    | 42 files, 338 tests pass        | `item28-integration.log`                                               |
| `build`                               | Pass                            | `item28-build.log`                                                     |
| `npm audit --audit-level=high`        | 0 vulnerabilities               | `item28-audit.log`                                                     |
