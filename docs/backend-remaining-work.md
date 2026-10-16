# Backend remaining work

Status recorded 2026-10-16. This is a working engineering checklist, not a
claim that the backend is launch-ready or a percentage-complete estimate.
Frontend/UI implementation belongs to the Flutter developer.

## Current milestone

- Trip-change history: structured, private, transactional history of material
  trip-plan/status/group changes. See [contract](trip-change-history.md).
- Apply its reviewed migration after merging before running the updated API.

## Feature/decision work still open

- Privacy-aware admin analytics/metrics. Agree the small set of useful counts,
  aggregation windows, staff access and retention; avoid collecting tracking
  identifiers or message/contact contents by default.
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

No new external key is required for trip history. Keep all service-account
files and provider secrets outside Git and chat. Complete feature work first,
then prepare the agreed provider/setup list together as requested by the founders.
