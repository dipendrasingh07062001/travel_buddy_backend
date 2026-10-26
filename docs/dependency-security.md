# Dependency security review

Last reviewed 2026-10-26. Audit results are a dated snapshot, not a guarantee
that dependencies have no vulnerabilities or that the backend is launch-ready.

## 2026-10-26: framework and validation patches

CI's high-severity audit gate began failing on `main` after new advisories were
published; the lockfile itself had not changed. `npm audit fix`, without
`--force`, moved nine lockfile entries to patched versions inside the existing
`package.json` ranges. `package.json` is unchanged, and no package was added or
removed. All new tarballs resolve from `registry.npmjs.org` with integrity hashes.

| Package      | Before        | After         | Reached through                                                                     | Advisories                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------- | ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zod`        | 4.6.5         | 4.6.7         | direct dependency                                                                   | high: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)                                                                                                                                                                                                                                         |
| `fastify`    | 5.12.5        | 5.12.7        | direct dependency                                                                   | low: [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8)                                                                                                                                                                                                                                          |
| `ip-address` | 10.7.2        | 10.7.5        | `@fastify/rate-limit`                                                               | moderate: [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)                                                                                                                                                                                                                                     |
| `fast-uri`   | 3.1.8 / 4.1.5 | 3.1.9 / 4.2.3 | Ajv in Fastify's schema compiler and serializer, `@fastify/swagger`, Prisma tooling | up to moderate: [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) |

`fast-uri` accounts for six of the nine entries: five nested 3.1.x copies and
one 4.x copy.

Before the fix, the full and `--omit=dev` audits each reported four packages
(one low, two moderate, one high); all four were production dependencies. After
the fix, `npm audit --package-lock-only`, the `--omit=dev` audit and the CI gate
all report zero findings. In this codebase Zod validates environment
configuration and Firebase recipient data rather than large user input, but
exposure was not analysed in depth: patching within the existing ranges was the
lower-risk path.

No application code, API contract or database migration changed. Verification
used `npm ci` from the updated lockfile, then the full CI sequence below.

## 2026-10-22: test-tool maintenance

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

## 2026-10-22: Firebase dependency maintenance and audit result

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
