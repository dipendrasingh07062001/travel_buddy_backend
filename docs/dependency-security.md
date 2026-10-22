# Dependency security review

Reviewed 2026-10-22. Audit results are a dated snapshot, not a guarantee that
dependencies have no vulnerabilities or that the backend is launch-ready.

## Test-tool maintenance

- Vitest and its mocker/spy packages: 5.0.2 to 5.0.5.
- Vite, used by Vitest: 8.3.1 to 8.3.5.
- Firebase Admin's optional Google Cloud Storage dependency: 8.1.0 to 8.4.0,
  within its existing supported `^8.1.0` range. Firebase Admin remains at 14.5.0.
- Application code, authentication rules and database migrations are unchanged.
- The updated lockfile addresses the reported
  [Vite Windows editor vulnerability](https://github.com/advisories/GHSA-587h-7wmj-h5pm)
  and [Vitest mock registration vulnerability](https://github.com/advisories/GHSA-qxg6-89mg-rqv8).

The production Dockerfile removes development dependencies. Vite and Vitest are
test tooling, not the Fastify production server. Keep development/test servers
private regardless of audit status.

## Firebase dependency maintenance and audit result

Both `npm audit --package-lock-only --audit-level=high` and the corresponding
`--omit=dev` audit report zero findings at every severity after these updates.
Before the updates, the full lockfile reported five affected packages, including
one high-severity finding. The two production findings were `uuid` and `gaxios`,
both moderate. These were two package findings for the same
[UUID buffer-bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
not two independent vulnerabilities.

The old path was Firebase Admin through Google Cloud Storage 8.1.0, then Gaxios
6.7.1 and UUID 9.0.1. Storage 8.4.0 declares newer Gaxios and Google Auth
dependencies; the updated lockfile resolves Gaxios 7.3.1 and removes UUID 9.0.1
and the superseded Google Auth 9 dependency subtree. This is an upstream-supported
storage update, not a forced Gaxios/UUID override or a Firebase Admin major upgrade.

The advisory concerns the UUID v3/v5/v6 APIs with a caller-supplied output buffer;
its presence alone did not establish that our API was exploitable. A clear audit
also does not replace live Firebase checks: authentication, revocation, push and
account cleanup still need verification with deployment credentials during
external setup. No real provider credentials are used in the isolated test suite.

Do not use `npm audit fix --force` or remove Firebase functionality just to make
an audit count zero. Re-run the audit regularly as advisories change.

## Repeatable verification

Use a disposable PostgreSQL database, not a development or production database,
for integration tests. CI installs from the lockfile with `npm ci`, then checks
formatting, lint, Prisma validation/migrations, types, unit tests, integration
tests, compilation and the high-severity audit gate. That gate remains unchanged.
Audit checks still need network access to the npm registry.

No provider key or new database migration is required for this maintenance step.
Live provider checks remain part of the [external setup checklist](backend-setup-checklist.md).
