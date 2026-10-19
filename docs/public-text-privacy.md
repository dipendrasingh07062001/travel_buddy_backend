# Public text privacy safeguards

This backend milestone reduces obvious personal-data disclosures in public text.
It is a deterministic validation and presentation layer, not a universal PII
detector, identity check, legal-compliance certification or automatic moderation
service. It introduces no provider, API key, dependency or database migration.

## Write behavior

Supported disclosures return HTTP `400` with code
`PUBLIC_TEXT_PRIVACY_VIOLATION`. The message asks the author to remove sensitive
details; it does not echo the rejected value or matched substring. Validation
occurs before the content write, so rejected changes do not create revisions,
trip-history entries or source notifications. The existing expected-error logger
records the status/code, not the content body.

The same reusable rule covers:

| Public-facing input                                                        | Operations                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Profile display name, home city/region, biography, languages and interests | Profile patch, including entries in arrays                                     |
| Trip origin city and description                                           | Draft creation, supplied edits, and full stored-value checks on publish/resume |
| Community post title/body                                                  | Creation and supplied edits                                                    |
| Community comment body                                                     | Creation and edits                                                             |
| Staff-managed public destination name, region, description and new slug    | Creation and supplied metadata edits                                           |

Profile fields can still be cleared with `null`, and privacy preferences can be
changed without rewriting existing text. Trip drafts use fields intended for
publication, so these rules apply on draft save too. Older drafts/paused trips
must have safe stored origin/description values before publishing; cancelling,
pausing, removing content or correcting an unsafe field is not blocked by a new
check of unrelated legacy content.

Firebase sign-in is not rejected when a new provider display name contains a
supported disclosure. That name is not copied into the new local public profile;
it starts as `null`, so the existing onboarding/completeness flow requests a safe
name. Verified Firebase email/phone identities remain private authentication data
and are not removed. Existing accounts are not rewritten by sign-in.

## Public responses and legacy records

A public text field with a supported disclosure is represented by
`[Hidden for privacy]`. The entire field is replaced in the response, not just a
regex substring. Null fields stay null. Safe text is returned unchanged, including
its original Unicode characters. Array entries use the same placeholder.

This covers public profiles, trip lists/details and owner labels, community
metadata, both community post list/detail presenters, comments and profile
trip/post/comment activity cards. Destination names/regions in activity/trip cards
also use the safe public presenter. Rows are not filtered out, so identifiers,
pagination and counts keep their existing meaning.

The response projection does not rewrite database records or automatically
unpublish, delete or report content. Private `/me` and owned-trip responses retain
the original profile/trip fields so the author can correct them. Community
post/comment public views, even when read by the author, use the placeholder;
there is no new private author-edit-preview endpoint in this milestone. Originals
remain stored for the existing authorized moderation inspection process, with
its existing access/audit controls. Private staff metadata reads also remain raw.

Private chat, connection introductions, financial notes/records, account exports,
moderation evidence and private staff reasons do not pass through this public-text
rule. Their existing authentication, membership and staff access controls remain
essential. This is not a change to retention or a grant of new staff access.

IDs and canonical destination slugs are not rewritten in public projections.
New slugs are checked, but any inappropriate legacy identifier/URL needs explicit
review and repair rather than silently breaking links. Existing caches or copies
of previously exposed content cannot be recalled by changing this code; review
deployment caching separately before launch.

## Detection boundaries

Inspection uses a separate NFKC-normalized copy, removes default-ignorable Unicode
characters and maps Arabic-Indic, Persian and Devanagari digits for comparison.
Successful validation never silently normalizes the stored author text beyond
the application's existing trim/list rules.

Supported patterns include:

- Conventional email addresses whose domain ends in letters, including common
  full-width and invisible-character variants. Times written like
  `Dinner@8.30` are not addresses.
- Explicit `+` international phone formats, Indian mobile-shaped numbers with
  optional `91`/`0091` or domestic `0` prefix (digits may be split by up to three
  spaces or dashes, including en/em dashes), phone-labeled numbers and numeric
  `tel:`, `sms:` and supported WhatsApp contact links. Labels may be followed by
  filler words, as in "my number is", "whatsapp me on" or "phone -". These are
  shapes, not verified phone numbers. Dotted number formats require an explicit
  phone label or `tel:`/`sms:` prefix; unlabelled dotted numbers are ambiguous
  with decimal prices and coordinates.
- PAN-shaped tokens, labeled Aadhaar-shaped numbers and labeled passport or
  national/government-ID tokens containing sufficient digits, including after
  words like "is" or "number is". No identity document validity or ownership
  is inferred.
- Explicit `home address`/`residential address` labels followed by a house/flat
  number, and explicit live/current/private-location labels followed by a URL,
  geo URI or coordinate pair.

Ordinary dates, times, group sizes, train references, public travel URLs,
destination names and public meeting coordinates are not blanket-banned. A rising
pair such as `60000-80000` is read as a price range, not a phone number, when a
money word (budget, price, cost, fare, fee, Rs, INR, rupees, ₹, $, €) appears
shortly before it in the same sentence or a currency or "each"/"per person"
follows it. A falling pair such as `98765-43210` is always treated as a phone
number. A reference that resembles an ID or phone can still be a false positive;
authors should rephrase the public text or use the existing support/report path.

These patterns cannot reliably distinguish every private street address from a
public meeting point, detect every international number/identifier/language,
classify images or attachments, or catch every spoken, encoded, split-field or
deliberately obfuscated disclosure. General links are not crawled. Human reporting,
moderation and appropriate user guidance remain necessary. No new appeal queue,
automated enforcement action, OCR provider or legal-policy version is activated.

Input schemas retain their existing length limits. Inspection also fails closed
above 20,000 characters for unexpectedly large legacy values. Pattern tests cover
long non-matching inputs and safe travel examples as well as disclosure cases.

## Verification

The rule tests cover detection, Unicode variants, safe travel text, non-echoing
errors, profile-array entries and staff metadata. PostgreSQL/API tests verify
rejected writes leave existing rows/history unchanged; legacy publish is blocked;
correction/cancellation remain possible; public list/detail/activity paths mask
legacy values without altering their originals; private owner/staff reads and
accepted private chat retain their intended behavior. The full regression suite
remains the merge gate.

Focused commands, with a separate migrated test database for integration tests:

```text
npx vitest run test/public-text.test.ts
npm run test:integration -- test/public-text.integration.ts
```

There is no production backfill or scanner to run after merge. No development or
production records should be edited merely to exercise these tests.
