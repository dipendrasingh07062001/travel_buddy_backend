# Item 28: Hosted Firebase credentials (finish PR #44)

- **Roadmap:** item 28, group 4 (launch setup). **PRD:** none directly; it
  enables sign-in on a hosted server (needed for the Railway test deployment
  for the Flutter developer, roadmap items 29 and 38).
- **Branch:** `feature/item-28-firebase-hosted-credentials` from `main`
  (`e95be53`).

## Problem

On `main`, `src/modules/auth/firebase-app.ts` gets Google credentials only
through `applicationDefault()`: a key file named by
`GOOGLE_APPLICATION_CREDENTIALS`, or a cloud host's built-in identity. Railway
has neither, and secrets there are environment variables, not files.

Without credentials, these HTTP routes return `503 AUTHENTICATION_UNAVAILABLE`:

- **Sign-in itself:** `POST /auth/bootstrap` asks Firebase whether the account
  is still enabled (`{ fresh: true }` in `auth.routes.ts`, passed on as
  `checkRevoked` in `auth.service.ts`).
- Every staff route (needed to create destination communities), account
  deletion, data export and data requests (`auth.service.ts`).
  Two background jobs also need credentials. They do not return a 503; they log
  the failure and retry: erasing a deleted user's Firebase login
  (`account-erasure.ts`) and push delivery (`push-delivery.ts`, only when
  `PUSH_NOTIFICATIONS_ENABLED=true`).

So without this item, nobody can sign in on Railway.

PR #44 (commit `14aa101`, 2026-10-23) adds the code but was never merged. It is
based on PR #43, about 16 merges behind `main`. A test merge onto `main` has no
conflicts.

## Proposed behaviour

1. **Bring PR #44's change onto `main`**, unchanged in behaviour:
   - A new optional setting, `FIREBASE_SERVICE_ACCOUNT_JSON`, holds the
     complete service-account JSON as one secret variable. If it is set, it is
     used and `applicationDefault()` is not.
   - The JSON must be a `service_account` with `project_id`, `client_email` and
     `private_key`, and `project_id` must equal `FIREBASE_PROJECT_ID`. Only
     those three fields are passed to the Firebase SDK.
   - If the secret is bad, the API never falls back to another credential and
     never logs or returns any part of it. Requests that need Firebase get the
     generic `503 AUTHENTICATION_UNAVAILABLE`.
   - When the setting is unset, local key files and cloud identities work as
     today.
2. **New: check the secret at startup (D2).** When
   `FIREBASE_SERVICE_ACCOUNT_JSON` is set, the server checks it **offline**
   before it listens or starts any worker: valid JSON, the required fields and
   `type`, `project_id` equal to `FIREBASE_PROJECT_ID`, and a `private_key` that
   parses as a PEM private key. If any check fails, the server exits with a
   non-zero code and one fixed message naming the check (for example
   "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON" or "its project_id does not
   match FIREBASE_PROJECT_ID"), never the value or the underlying error.
   Railway then shows a failed deployment with a clear reason. Under PR #44 as
   written, a malformed secret would pass the health check while every sign-in
   returned 503 with nothing in the logs.

   **Limit:** an offline check cannot tell whether Google still accepts the key
   (for example a deleted or revoked key). That shows up only when the API calls
   Firebase: the routes above return the generic 503. The owner's live
   checklist (a real sign-in after deploying) covers it.

3. **Docs:** keep PR #44's `docs/firebase-hosted-credentials.md`, `README.md`,
   `.env.example` and setup-checklist changes, updated for the startup check;
   set item 28 to done in `docs/roadmap.md`; and update
   `docs/backend-remaining-work.md` (current milestone and "Already
   implemented").

## Data

None. No migration.

## Privacy and safety

- The secret is a full admin key for the Firebase project. It must never be
  committed, logged, sent to Flutter, passed as a Docker build argument or
  pasted into chat. `.gitignore` and `.dockerignore` gain the usual key-file
  patterns (`secrets/`, `.config/`, `*-firebase-adminsdk-*.json`,
  `firebase-service-account*.json`).
- Startup and request errors use fixed messages only; the original errors are
  dropped because they can contain key fragments.
- The owner creates and stores the key; agents never see it.

## Out of scope

- Setting up Railway itself, creating the key, and live Firebase checks (items
  29, 31 and 32, done by the owner with a checklist).
- Turning on push notifications or R2.

## Acceptance criteria

1. [ ] With `FIREBASE_SERVICE_ACCOUNT_JSON` unset, `firebaseApp()` behaves as on
       `main` (`applicationDefault()`); existing tests pass.
2. [ ] With a valid secret, the app is created with `cert()` from only
       `project_id`, `client_email` and `private_key`, once (reused after).
3. [ ] Startup check, tested by running the real server entry point in a
       child process with a synthetic secret containing a unique marker string:
       invalid JSON, a wrong `type`, a missing field, a different `project_id`
       and an unparseable `private_key` each exit non-zero before the server
       listens, with the fixed message. The marker never appears in the child's
       stdout or stderr. This also covers the existing environment-error and
       fatal-startup output paths.
4. [ ] Unset and valid synthetic credentials pass the startup check (a valid
       synthetic key is generated in the test; no real key is used).
5. [ ] If Firebase rejects the key at request time, the response is the generic
       503 and the raw error is not kept or logged.
6. [ ] No fallback to `applicationDefault()` after a configured secret fails.
7. [ ] Ignore rules and the docs in proposed behaviour 3 are updated.
8. [ ] All checks in `AGENTS.md` pass, with full output saved to `*.log` files
       in the repository root (as `AGENTS.md` on `main` requires).

## Decisions for the owner

- **D1. How to land it.** Recommended: **a new branch and pull request with
  PR #44's commit brought over (cherry-pick), then close PR #44** with a link
  to the new one. This keeps our workflow files with the change and needs no
  force-push. Alternative: rebase PR #44's own branch and force-push it.
- **D2. Startup check.** Recommended: **yes**, stop at startup when the secret
  is set but invalid (proposed behaviour 2). Alternative: keep PR #44 as is
  (a malformed secret passes the health check; sign-in fails with 503).
