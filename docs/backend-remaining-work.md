# Backend remaining work

Status recorded 2026-10-17. This is a working engineering checklist, not a
claim that the backend is launch-ready or a percentage-complete estimate.
Frontend/UI implementation belongs to the Flutter developer.

## Current milestone

- Home discovery: recent public posts across all communities and a transparent
  `activity` sort for communities. See [contract and rules](home-discovery.md).
- No new database migration, provider or API key is required for this milestone.

## Already implemented

- Public-text privacy: reject supported disclosures in public-facing writes and
  mask matching legacy text in public responses without rewriting stored content.
  See [scope, behavior and limits](public-text-privacy.md).
- Atomic connection-request quota: serialize the rolling 20-per-requester limit
  with request/notification creation in PostgreSQL. See [rules and tests](connection-request-limits.md).
- Trip-change history: structured, private, transactional history of material
  trip-plan/status/group changes. See [contract](trip-change-history.md).
  Its migration is part of the existing 34-migration baseline.
- Administrator metrics: private operational counts/status breakdowns and rolling
  creation windows. See [definitions and access rules](admin-metrics.md). This is
  not an admin dashboard or the PRD's full product-success measurement.

## Feature/decision work still open

- The initial operational admin counts are already implemented.
  Daily/monthly engagement, conversion funnels or historical series are not
  included; confirm a product need and privacy/retention decisions before adding
  tracking. They are not silently treated as required MVP features.
- Moderation follow-up: founders must agree severity/escalation, appeals and
  response expectations. Existing report review/removal is not a complete
  operational moderation policy. Implement any agreed workflow gaps separately.
- Account/policy notice coverage: decide which notices are mandatory versus
  optional and approved content/version rules. Existing policy acceptance and
  opt-in email preferences do not settle these decisions.
- Explicit public trip-status filter for trip search (PRD §7.3). The
  cross-community recent posts list is done; a mixed trips-and-posts timeline
  is not needed because the home design uses separate sections.
- Community cover images: the Flutter design shows a photo on every community
  card, but communities have no image field yet. Needs an admin upload flow
  using the existing object storage; plan it as its own milestone.
- Recheck PRD-to-API coverage at the end, including edge cases across features.

## Deferred external integrations and launch checks

Maintain the detailed [external setup checklist](backend-setup-checklist.md).
It includes real email provider/domain and unsubscribe/bounce handling, live
Firebase/FCM and storage checks, approved policy URLs/versions, production
hosting/secrets/HTTPS/CORS, backups and restore, monitoring, security/load tests
and final API integration. These require separate verification, not just PRs.

No new external key is required for these public-text safeguards. Keep all service-account
files and provider secrets outside Git and chat. Complete feature work first,
then prepare the agreed provider/setup list together as requested by the founders.
