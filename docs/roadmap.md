# Backend roadmap

The numbered list of open PRD gaps agreed on 2026-10-24, with each item's
status. Work one item at a time, in the order the owner chooses (see
[`AGENTS.md`](../AGENTS.md)). When an item is merged, mark it done here with its
pull request number; the number can be added in the next item's branch.

Status recorded 2026-10-28.

## Group 1: coding gaps (no API key needed)

| #   | Item                            | Status                                                                                                                                 |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recent public-activity feed     | Done, PR #45. Built as separate home sections to match the Flutter design: `GET /community-posts` and `GET /communities?sort=activity` |
| 2   | Trip-status filter              | Done, PR #48. A documented decision: `availableOnly` covers it, no new parameter                                                       |
| 3   | Weekend and month date windows  | Done, PR #49                                                                                                                           |
| 4   | Notices when moderators act     | Done, PR #50                                                                                                                           |
| 5   | Partial feature restrictions    | Done, PR #51                                                                                                                           |
| 6   | Require a profile photo         | Done, PR #52. `PROFILE_PHOTO_REQUIRED` switch, off by default; turning it on is a founder decision                                     |
| 7   | Former member as payer          | Done, PR #53                                                                                                                           |
| 8   | Expense note                    | Done, PR #54                                                                                                                           |
| 9   | Settlement method text          | Done, PR #55                                                                                                                           |
| 10  | Record the publish confirmation | Done, PR #56. The Flutter app must send `confirmsPersonalPlan`                                                                         |
| 11  | Explain rounding                | Done, PR #57                                                                                                                           |
| 12  | Analytics events                | Open. Needs decision 27 and a privacy decision (what is tracked, linked to accounts or not, how long kept) before any code             |

## Group 2: email (needs an email provider and a domain)

| #   | Item                             | Status |
| --- | -------------------------------- | ------ |
| 13  | Real email sender                | Open   |
| 14  | New-message emails               | Open   |
| 15  | Matching-trip emails             | Open   |
| 16  | Unsubscribe and suppression list | Open   |
| 17  | Bounce and complaint handling    | Open   |

## Group 3: founder decisions (shape or block code)

| #   | Decision                                                 | Status |
| --- | -------------------------------------------------------- | ------ |
| 18  | One-to-one private chat, or group trip room only         | Open   |
| 19  | Who accepts requests: owner only, or trusted members too | Open   |
| 20  | How long data is kept, and the read-only grace period    | Open   |
| 21  | Moderation severity levels, response times, appeals      | Open   |
| 22  | Which notices are mandatory and which optional           | Open   |
| 23  | Approved Terms, Privacy Notice and Community Standards   | Open   |
| 24  | Identity check at beta                                   | Open   |
| 25  | Login method: email, phone or both                       | Open   |
| 26  | Exact trip dates for guests, or less detail until login  | Open   |
| 27  | Which success metrics to track (needed before item 12)   | Open   |

## Group 4: launch setup (no new features)

| #   | Item                                                                    | Status                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 28  | Merge PR #44 (hosted Firebase credentials)                              | Open: PR #44 is not merged                                                                                                             |
| 29  | Hosting, domain, HTTPS                                                  | Open                                                                                                                                   |
| 30  | Production database, backups and a tested restore                       | Open                                                                                                                                   |
| 31  | Secure secret storage                                                   | Open                                                                                                                                   |
| 32  | Live Firebase checks                                                    | Open                                                                                                                                   |
| 33  | Push notification test on a real phone                                  | Open                                                                                                                                   |
| 34  | R2 file storage setup and tests                                         | Open                                                                                                                                   |
| 35  | CORS and proxy settings                                                 | Open                                                                                                                                   |
| 36  | Monitoring, error alerts, incident contact                              | Open                                                                                                                                   |
| 37  | Security and load tests, shared rate-limit store                        | Open                                                                                                                                   |
| 38  | Give the Flutter developer the API URL and contract, then test together | Open                                                                                                                                   |
| 39  | Fix flaky tests                                                         | Open: `test/rate-limit.test.ts` timeouts, and integration `beforeAll` hook timeouts (15 s) when the whole suite runs on a busy machine |

## Found later (not in the original 39)

| Item                                                                          | Status       |
| ----------------------------------------------------------------------------- | ------------ |
| Dependency security update                                                    | Done, PR #46 |
| Policy-acceptance race (duplicate submissions returned 500)                   | Done, PR #47 |
| Community cover images (the Flutter design shows one on every community card) | Open         |
| Duplicate-submission audit of the other `upsert` calls                        | Open         |
| Automatic stricter limits for new accounts (PRD §9.2)                         | Open         |
