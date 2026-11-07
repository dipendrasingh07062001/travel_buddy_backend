# Staff role management

- **Roadmap:** found later (not in the original 39); second admin panel step,
  after admin user search (PR #64).
- **PRD sections:** §14 FR-15 (authorised staff manage account states with
  audit logging), §15.1 (moderation console and audit logs), §16
  (Moderator/Admin role), §18 (least privilege, auditability: "material
  account ... changes produce tamper-resistant logs").
- **Branch:** `feature/staff-role-management`, from `main` at `99966f1`.

## Problem

Today staff roles can only be changed by someone with direct database
credentials, using `npm run staff:grant` and `npm run staff:revoke`
(`scripts/grant-staff.ts`, `scripts/revoke-staff.ts`). README "Staff
moderation" says roles are provisioned "only by a database operator, never
through a public API". An administrator using the admin panel therefore
cannot:

- give a trusted user the moderator role;
- take the moderator role away, for example when a volunteer leaves or
  misuses access.

Each change needs a developer with production database access, which is slow
and gives more people database credentials than the task needs.

What exists and is reused:

- `ModerationActionType` already has `STAFF_ROLE_GRANTED` and
  `STAFF_ROLE_REVOKED`; the CLI writes them with no `actorId`.
- `staffIdentity` (fresh Firebase check plus `requireStaff`) and
  `requireAdmin` (`403 ADMIN_ONLY`).
- `requireStaff` reads the role from the database on every staff request, so
  a role change takes effect on the next request; there is no token or cache
  to expire.
- `GET /admin/users?staffRole=MODERATOR` (PR #64) already lists staff, so no
  new list route is needed.
- `GET /admin/moderation-actions` (administrators only) already shows every
  audit row.

## Proposed behaviour

### `POST /api/v1/admin/users/:userId/staff-role`

Administrators only. Body:

```json
{ "role": "MODERATOR" | "USER", "reason": "at least 10 characters" }
```

- `role: "MODERATOR"` grants the moderator role; `role: "USER"` removes it.
  `ADMIN` is not accepted (see D1); the schema rejects it with
  `400 REQUEST_ERROR`.
- `reason` uses the existing `reasonSchema` (10 to 1000 characters) and
  `cleanReason` (at least 10 characters after trimming,
  `400 INVALID_MODERATION_REASON`), like suspend and restore.

Response `200`:

```json
{
  "data": {
    "userId": "…",
    "staffRole": "MODERATOR",
    "changed": true,
    "claimedReportCount": 0
  }
}
```

The route sends `Cache-Control: no-store`. It is limited to 10 requests per
minute per account.

### Rules, in order

1. Fresh staff check (`staffIdentity`), then `requireAdmin`: other callers
   get the existing auth errors, or `403 STAFF_ONLY` / `403 ADMIN_ONLY`.
2. `userId` must be a UUID (schema), and the account must exist, otherwise
   `404 USER_NOT_FOUND`.
3. An administrator cannot change their own role, and nobody can change an
   `ADMIN` account's role through the API: `403 STAFF_TARGET_PROTECTED`.
   Admins stay CLI-only (D1).
4. If the target already has the requested role, nothing changes and no
   audit row is written: `200` with `changed: false`. A double-tap is
   therefore harmless, which is consistent with PRD §18 idempotency for
   duplicate submissions.
5. **Grant** (`USER` to `MODERATOR`): the target must be `ACTIVE`, otherwise
   `409 USER_NOT_ACTIVE`. Suspended, pending-deletion and deleted accounts
   cannot become staff.
6. **Revoke** (`MODERATOR` to `USER`): allowed in any status, so a suspended
   or departing moderator can always lose access.
7. The change is a compare-and-set in one transaction with its audit row:
   - grant: `updateMany where { id, staffRole: 'USER', status: 'ACTIVE' }`, so
     a suspension or deletion that commits after the read cannot leave a
     non-active account promoted (as `suspendUser` guards its own update);
   - revoke: `updateMany where { id, staffRole: 'MODERATOR' }`.

   If the update matches no row, the request fails with
   `409 USER_STATE_CHANGED` (existing code). Nothing changes and no audit row
   is written; the caller re-reads and retries.

### Audit

The transaction writes one `moderation_actions` row:

- `STAFF_ROLE_GRANTED` or `STAFF_ROLE_REVOKED`;
- `actorId`: the administrator;
- `targetType: USER`, `targetId`: the account;
- `reason`: the administrator's cleaned reason.

Unlike CLI rows, API rows carry a real `actorId`. They appear in
`GET /admin/moderation-actions` as they are. If the audit write fails, the
role does not change.

### Reports a revoked moderator had claimed (D2)

Revoking does not change any report. Reports the moderator had claimed
(`UNDER_REVIEW` with `reviewerId` = target) stay claimed. Administrators can
already resolve any report under review (`resolveReport` lets `ADMIN`
override the reviewer), and the revoked moderator can no longer act on them,
because every staff request rechecks the role.

To make this visible, every `200` response, including grants and
`changed: false` repeats, includes `claimedReportCount`: the number of
`UNDER_REVIEW` reports with `reviewerId` = target. It is read in the same
transaction, after the update when there is one. It is a snapshot from that
query. A claim or an administrator's resolution in flight can change the
number right after, so it is information only, not a guarantee. Nothing is
released. On a grant it is usually `0`; it can be higher if a former
moderator still has claims from before.

Automatic release back to the queue was considered and deferred (round 1,
S1-2 and S1-3). It would race with claims and resolutions that are already
authorised. Doing it safely needs write-time ownership checks in the
existing report operations and a report-linked audit event, which is a
separate item.

Residual risk, unchanged from today: a staff request that passed its role
check just before a revoke committed can still finish. This applies to every
staff route, not only this one. Requests that start after the revoke commits
are rejected.

### Notifications (D3)

None. The target is not notified. Moderators are onboarded outside the app,
and the notification types are fixed.

## Data

No migration: both enum values and every column already exist.

## Privacy, safety and abuse

- **Least privilege (D1).** The API can only move accounts between `USER` and
  `MODERATOR`. A stolen administrator token cannot create more
  administrators or remove the other administrators, so the
  "last active administrator" rule stays only in the CLI, where it is today.
- **Fresh checks.** `staffIdentity` checks Firebase revocation on every call,
  and a revoked moderator loses access on their next request.
- **No self-change**, so an administrator cannot lock themselves out or hide
  a role change behind their own account.
- **Audit.** Every change is a moderation action with actor and reason,
  written in the same transaction. No-op requests write nothing, so the trail
  is not padded.
- **Response minimisation.** The response returns only the ID, the new role,
  `changed` and `claimedReportCount`, never contacts or other account data.
- **Logs.** The `reason` is in the request body, which is not logged.
- **Rate limit.** 10 per minute per administrator is enough for real use and
  limits damage from a stolen token.

## Out of scope

- Granting or revoking `ADMIN` through the API (CLI only, D1).
- Changes to the CLI scripts.
- Notifying the target.
- Releasing a revoked moderator's claimed reports (deferred, D2).
- A per-moderator activity view.
- The admin panel UI.

## Acceptance criteria

- [ ] `POST /admin/users/:userId/staff-role` exists with the schema above;
      `role: ADMIN` is rejected with `400`. Unknown fields are dropped by the
      app's validator and have no effect (corrected during the build; see
      plan.md "Changes from the plan" and code review C1-1).
- [ ] Callers: no token gives `401`; a moderator gets `403 ADMIN_ONLY`; an
      ordinary user gets `403 STAFF_ONLY`; a revoked Firebase token is
      rejected.
- [ ] Unknown account: `404 USER_NOT_FOUND`. Own account, or an `ADMIN`
      target: `403 STAFF_TARGET_PROTECTED`.
- [ ] Grant on an `ACTIVE` `USER` gives `200 changed: true` and role
      `MODERATOR`. The new moderator can use a staff route, such as
      `GET /admin/reports`, on their next request.
- [ ] Grant on a suspended, pending-deletion or deleted account:
      `409 USER_NOT_ACTIVE`, with no change and no audit row.
- [ ] Revoke on a moderator, including a suspended one, gives `200` and role
      `USER`. An active revoked moderator's next staff request gets
      `403 STAFF_ONLY`. A suspended one keeps getting the existing
      `403 ACCOUNT_SUSPENDED`, which `authenticateRequest` checks first.
- [ ] Repeating the same request gives `200 changed: false`, with no second
      audit row.
- [ ] Each change writes exactly one `STAFF_ROLE_GRANTED` or
      `STAFF_ROLE_REVOKED` row with `actorId`, target and the cleaned reason.
      It is visible in `GET /admin/moderation-actions`.
- [ ] If the audit write fails, the role is unchanged (fail-closed test).
- [ ] A lost race gives `409 USER_STATE_CHANGED`, with no role change and no
      audit row. It is tested by changing the state between the read and the
      update:
  - for a grant, the target's role, and separately its status (suspended);
  - for a revoke, the target's role.
- [ ] Revoke leaves the moderator's `UNDER_REVIEW` reports unchanged (status,
      `reviewerId`, `reviewedAt`), and `claimedReportCount` equals their
      number. Reports claimed by other moderators are not counted. An
      administrator can still resolve those reports afterwards.
- [ ] `Cache-Control: no-store`. The 11th request in a minute gets `429`.
- [ ] README "Staff moderation" is updated: API for moderators, CLI still
      for administrators. `docs/backend-remaining-work.md` and
      `docs/roadmap.md` are updated. All AGENTS.md checks pass.

## Decisions for the owner

- **D1. Which roles can the API change?** Recommended: `USER` and `MODERATOR`
  only; `ADMIN` stays CLI-only. The alternative, letting admins grant and
  revoke `ADMIN` too, adds a last-admin check to the API and lets one stolen
  admin token take over staff access.
- **D2. Claimed reports on revoke.** Recommended: leave them claimed, report
  `claimedReportCount`, and have administrators resolve them with the existing
  override. Automatic release is deferred to its own item: doing it safely
  means changing the report claim and resolve operations and adding a
  report-linked audit event (round 1, S1-2 and S1-3).
- **D3. Notify the target?** Recommended: no.
- **D4. Rate limit.** Recommended: 10 per minute per administrator.
