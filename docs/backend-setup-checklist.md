# Backend external setup and launch checklist

Keep this list as we finish backend milestones. No purchase, provider signup,
API key, or production activation is requested by this document. Items below
are not automatically complete because a feature has tests or its PR merged.
Some external approvals and DNS changes take time; group the setup work into
a dedicated milestone after feature work, then verify each service separately.

## Prepare together after backend feature work

- [ ] Final project/brand name and a domain owned by the founders.
- [ ] Backend hosting, deployment region, HTTPS API hostname and TLS setup.
- [ ] Production PostgreSQL service, restricted database credentials, backup
      schedule, retention decision and a successful restore test.
- [ ] Production secret storage. Keep `.env`, service-account JSON and provider
      keys out of GitHub and chat; install secrets locally/on the deployment host.
- [ ] Production Firebase project and Admin credentials/workload identity;
      both are required: sign-in, data requests/export and staff routes check
      the Firebase account on each call and return 503 without credentials.
      Validate login, a disabled account (blocked at once on those actions,
      within an hour elsewhere) and account-cleanup permissions.
- [ ] Actual-device FCM validation before turning on push notifications;
      in-app notifications already work independently of FCM.
- [ ] Public/private object storage configuration (currently R2 integration),
      media hostname, bucket access controls, credentials, upload/read/delete tests,
      private receipt isolation and account-deletion cleanup verification.
- [ ] Founder decision: whether a profile photo is required (PRD §5.4). If so,
      set `PROFILE_PHOTO_REQUIRED=true` only after the storage checks above pass;
      the API refuses to start with it on while any `R2_*` setting is missing.
- [ ] Choose an email provider and implement its real sender adapter. Verify
      a sending domain/address using that provider's DNS instructions. Configure
      provider credentials, timeouts and idempotency for the full retry window.
- [ ] Finish email unsubscribe links/one-click handling, suppression lists,
      authenticated bounce/complaint webhooks and production sender identity.
      These require the selected provider and domain; they are NOT supplied by
      the provider-neutral email foundation. Do not enable real sending first.
- [ ] Live email tests to addresses controlled by the founders: current verified
      Firebase email, address changes, opt-out, retries, bounces and account deletion.
- [ ] Founder-approved Terms, Privacy Notice and Community Standards with
      version numbers, published HTTPS URLs and an agreed acceptance policy.
      Existing policy gates remain off until the approved documents are configured.
- [ ] Founder decisions for retention, moderation escalation/appeals, response
      expectations, support contact and any additional mandatory account notices.
      Do not invent legal obligations, approved policy wording or identity guarantees.
- [ ] Explicitly grant the founders' staff roles; verify least-privilege access.
- [ ] Set production CORS origins and trusted proxy hops for the actual host.
- [ ] Install dependencies, generate Prisma Client, apply reviewed migrations,
      build and deploy. Do not seed demonstration users/trips into production.
- [ ] Verify health/readiness, graceful shutdown, background workers and restore
      recovery. Add monitoring, redacted error reporting, alerts and an incident contact.
- [ ] Run deployed API security/regression/load checks against agreed usage
      targets. If running multiple instances, configure a shared rate-limit store.
      Recheck dependencies using the dated
      [dependency security review](dependency-security.md).
- [ ] Supply the Flutter developer the HTTPS API base URL and current OpenAPI
      contract; jointly verify integration. Flutter/UI implementation remains theirs.

## Current email milestone boundary

The foundation provides private opt-in preferences, an allowlisted outbox,
retry/claim handling, live Firebase recipient resolution and fake-sender tests.
There is deliberately **no configured real sender**, no console sender and no
public send-to-address endpoint. While unconfigured, source actions do not queue
email and no email worker starts; old inbox events are not replayed later.
Buying a domain or adding a random `EMAIL_*` variable does not enable delivery.
Real sending needs the reviewed adapter and the email setup checks above.

Matching-trip alerts remain in-app only. Chat-message emails are not included.
The optional `safety` email category currently covers profile-photo removal
only; it is not a substitute for a future approved mandatory-notice policy.

## Keep separate from external setup

This checklist is not a claim that every PRD feature is finished. Continue the
backend gap audit separately: see [remaining feature work](backend-remaining-work.md)
for account/policy notices, moderation, analytics and confirmed discovery gaps.
Trip-change history has its own [contract](trip-change-history.md).
Do not label the backend launch-ready until
feature decisions, provider checks and operational tests are all complete.
