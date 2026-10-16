# Backend remaining work

Status recorded 2026-10-16. This is a working engineering checklist, not a
claim that the backend is launch-ready or a percentage-complete estimate.
Frontend/UI implementation belongs to the Flutter developer.

## Current milestone

- Atomic connection-request quota: serialize the rolling 20-per-requester limit
  with request/notification creation in PostgreSQL. See [rules and tests](connection-request-limits.md).
- No new database migration, provider or API key is required for this milestone.

## Already implemented

- Trip-change history: structured, private, transactional history of material
  trip-plan/status/group changes. See [contract](trip-change-history.md).
  Its migration is part of the existing 34-migration baseline.
- Administrator metrics: private operational counts/status breakdowns and rolling
  creation windows. See [definitions and access rules](admin-metrics.md). This is
  not an admin dashboard or the PRD's full product-success measurement.

## Feature/decision work still open

- The initial operational admin counts are covered by the current milestone.
  Daily/monthly engagement, conversion funnels or historical series are not
  included; confirm a product need and privacy/retention decisions before adding
  tracking. They are not silently treated as required MVP features.
- Moderation follow-up: founders must agree severity/escalation, appeals and
  response expectations. Existing report review/removal is not a complete
  operational moderation policy. Implement any agreed workflow gaps separately.
- Account/policy notice coverage: decide which notices are mandatory versus
  optional and approved content/version rules. Existing policy acceptance and
  opt-in email preferences do not settle these decisions.
- Confirm smaller discovery requirements against the final contract: explicit
  public trip-status filters and a cross-community recent feed, if required.
  Do not add speculative endpoints without confirming the product need.
- Recheck PRD-to-API coverage at the end, including edge cases across features.

## Deferred external integrations and launch checks

Maintain the detailed [external setup checklist](backend-setup-checklist.md).
It includes real email provider/domain and unsubscribe/bounce handling, live
Firebase/FCM and storage checks, approved policy URLs/versions, production
hosting/secrets/HTTPS/CORS, backups and restore, monitoring, security/load tests
and final API integration. These require separate verification, not just PRs.

No new external key is required for these admin metrics. Keep all service-account
files and provider secrets outside Git and chat. Complete feature work first,
then prepare the agreed provider/setup list together as requested by the founders.
