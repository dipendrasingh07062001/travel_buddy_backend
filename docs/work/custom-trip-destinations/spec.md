# Custom trip destinations

- **Roadmap:** "Found later" table, new row "Custom trip destinations (a trip
  may name any destination; a community link is optional)". Raised by the
  Flutter developer's handoff "Backend handoff: trips with typed destinations".
- **PRD sections:** §7.1 (Destination: "Required destination; may link to a
  community"; Budget; Group), §6.1 and §6.2 (communities are curated hubs
  maintained by administrators), §6.3 (feed rules), §6.4 (public text).
- **Branch:** `feature/custom-trip-destinations`.

## Problem

A trip must belong to an existing community today, so a user cannot plan a
trip to any place an administrator has not created a community for. The local
seed has three (Manali, Spiti Valley, Ladakh). PRD §7.1 only requires a
destination and says it _may_ link to a community, so the backend is stricter
than the PRD.

Users cannot create communities, and this item keeps it that way: PRD §6.2 and
§20.1 make communities curated hubs (`POST /api/v1/admin/communities` is
admin-only). A custom destination is a field on the trip, not a new community.

### What I checked (2026-11-07, `main` at `0ecb999`)

| Where                                                            | Today                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma` `Trip`                                    | `communityId` NOT NULL, relation required; `description` NOT NULL                                                                                                                                                |
| `POST /trips` schema (`trip.routes.ts`)                          | requires `communityId` and `description` (20–2000 characters)                                                                                                                                                    |
| `createTrip`, `updateTrip` (`trip-management.service.ts`)        | `validateCommunity` rejects an unknown or archived community with `INVALID_COMMUNITY`                                                                                                                            |
| Public search (`trip.repository.ts:56`, `:62`, `:98`)            | inner `JOIN communities` with `c."status" = 'ACTIVE'`; `destination` filter is an exact slug match                                                                                                               |
| `findPublicById` (`trip.repository.ts:140`)                      | `community: { status: 'ACTIVE' }`, which excludes a trip with no community                                                                                                                                       |
| Profile activity (`profile-activity.repository.ts:46`)           | same relation filter                                                                                                                                                                                             |
| Publish (`trip-management.repository.ts:141`)                    | writes a `trip_publication_alerts` row whose `community_id` is NOT NULL                                                                                                                                          |
| Alert worker and matcher (`trip-alert.worker.ts`, `.matcher.ts`) | alerts are per community                                                                                                                                                                                         |
| Presenters                                                       | `trip.presenter.ts`, `profile-activity.presenter.ts`, `connection.presenter.ts`, `messaging.presenter.ts` read `trip.community`; `messaging.presenter.ts:18` calls `.countryCode.trim()` and would throw on null |
| Response schemas                                                 | `destination.id` (uuid), `slug` and `countryCode` are non-null strings                                                                                                                                           |
| Trip history (`trip-history.ts`)                                 | records `communityId` changes                                                                                                                                                                                    |
| Data export (`data-export.repository.ts:108`)                    | exports `communityId` only                                                                                                                                                                                       |

The rest of the Flutter "simple form" request already works and needs no
change: create defaults (`EXACT`, `flexibilityDays` 0, `weekendsOnly` false,
`UNDECIDED`, `INR`), exact-trip length from the dates, nullable budgets from 0
to 9999999999.99 with min ≤ max, `desiredGroupSize` 1–100 not below
`currentGroupSize`, occupancy starting at 1 and kept by accept, leave, removal
and account erasure, and PATCH keeping omitted fields. The owner can still set
`currentGroupSize` by hand (PRD §7.1 "Current members" covers friends who are
not on the platform), never below the active members.

## Proposed behaviour

### Destination on create (`POST /api/v1/trips`)

Send exactly one of:

- `communityId`: an active community's UUID. Unchanged behaviour; an unknown or
  archived community still returns `400 INVALID_COMMUNITY`.
- `destinationName`: any place name. The request value may be at most 120
  characters (checked by the schema before trimming, as with `originCity`),
  and it must not be blank after trimming.

Rules:

- Neither, both, or a name that is blank after trimming:
  `400 INVALID_DESTINATION`. A request value over 120 characters, including
  outer spaces, fails schema validation (`400`), like other length limits.
- `destinationName` goes through `requireSafePublicText`
  (`400 PUBLIC_TEXT_PRIVACY_VIOLATION`) and is stored trimmed.
- **Auto-link (owner decision 4).** If the trimmed name equals the `name` of
  exactly one active community, ignoring case, the trip is linked to that
  community and stores no custom name, exactly as if `communityId` had been
  sent. Otherwise the trip keeps the custom name. Inner spaces are compared as
  sent; slug and region are not compared. Two or more active matches link
  none (D1). An archived community never matches, so one active match plus an
  archived one links the active one. No community is ever created.

### Destination on edit (`PATCH /api/v1/trips/:tripId`)

- Either field may be sent, never both (`400 INVALID_DESTINATION`).
- `communityId` links the trip and clears the custom name.
- `destinationName` follows the create rules (including auto-link): it either
  links a matching community or stores the custom name and clears the link.
- Neither: the destination is unchanged.
- `expectedVersion`, owner checks, editable statuses and the existing error
  codes are unchanged.

### Description is optional (owner decision 2)

- `description` becomes optional on create; omitted or `null` stores `null`. No
  text is generated.
- On edit, `"description": null` clears it; omitting it keeps it.
- A string keeps today's rules (20–2000 characters, `requireSafePublicText`).
- Every trip response returns `description` as a string or `null`.

### Budget meaning (owner decision 3)

No API change. The API docs and README say `budgetMin` and `budgetMax` are an
approximate **per-person** range in INR, entered by the owner, not a quote.

### Responses

`destination` stays an object on every response that includes a trip:
create, update, status actions, `GET /trips/:tripId`, `GET /trips`,
`GET /me/trips`, `GET /me/trip-memberships`, community trip lists, profile
activity, connection requests and the trip room.

A linked trip is unchanged. A custom trip returns:

```json
"destination": {
  "id": null,
  "slug": null,
  "name": "Kasol",
  "region": null,
  "countryCode": null
}
```

Responses that today show only part of the destination (connection requests:
`slug`, `name`) keep their fields, with `slug` nullable. The name goes through
`publicText` wherever other public text does, and the owner sees the original
on owner responses, as with `originCity`. The response schemas are updated so
nothing is dropped.

### Lists, feeds and search

- `GET /trips` and `GET /trips/:tripId` include custom trips. A linked trip
  still needs an active community.
- `GET /communities/:slug/trips` and community trip counts include only trips
  linked to that community.
- `GET /me/trips`, `GET /me/trip-memberships` and profile activity include
  custom trips.
- The `destination` slug filter on `GET /trips` matches linked trips only, as
  today. Text search on destination names is deferred (owner decision 5).

### Alerts, history and export

- Publishing a custom trip creates no publication alert, because alerts are per
  community. An auto-linked trip alerts like any linked trip.
- A change of destination is a material plan change (PRD §7.5). Today the
  member notice (`TRIP_UPDATED`, `trip-management.repository.ts:154`) and the
  history snapshot (`trip-history.ts`) look at `communityId` only, so a custom
  → custom edit (Kasol → Tosh) would be missed. `destinationName` joins both:
  - Active members get the existing `TRIP_UPDATED` notice, with its fixed
    title, for linked → custom, custom → linked, custom → custom and linked →
    linked changes. The destination name is never put in the title.
  - Trip history records `destinationName` before and after, next to
    `communityId`, like `originCity`. Unlike the description, the name is short
    public text that already passed the privacy check, so its text is kept.
- A publication alert already queued for a linked trip that is then edited to
  custom is dropped by the worker, as it is today when the community changes
  (`trip-alert.worker.ts:77-85`).
- The personal data export includes `destinationName`.

### Moderation

PRD §6.4 needs staff to see what was reported. Staff report detail for a trip
(`moderation.repository.ts:160`) shows `description` but no destination, and a
trip may now have no description. The trip target in staff report detail adds
`communityId` and `destinationName`, so staff see the stored custom name or
which community the trip links to. Access control, the inspection audit and
removal are unchanged.

### Example: simple-form request

```json
{
  "destinationName": "Kasol",
  "originCity": "Jaipur",
  "startDate": "2026-11-10",
  "endDate": "2026-11-17",
  "desiredGroupSize": 4,
  "budgetMin": 5000,
  "budgetMax": 12000
}
```

The OpenAPI example for `POST /trips` becomes this request; the limits stay in
each field's schema.

## Data

One migration:

- `trips.community_id` becomes nullable; the foreign key stays
  `ON DELETE RESTRICT`.
- New column `trips.destination_name VARCHAR(120)`, nullable.
- `trips.description` becomes nullable.
- CHECK constraint `trips_destination_check`, written so that no case can
  evaluate to NULL (PostgreSQL accepts a CHECK that is NULL):

  ```sql
  CHECK (
    (community_id IS NOT NULL AND destination_name IS NULL)
    OR (community_id IS NULL AND destination_name IS NOT NULL
        AND btrim(destination_name) <> '')
  )
  ```

  A linked trip must have no custom name at all, not even an empty one.

No backfill: every existing trip has a community, which satisfies the
constraint. Existing custom names are not linked later when an admin creates
a matching community (see Out of scope).

## Privacy, safety and abuse

- The custom name is public text: checked by `requireSafePublicText` on write
  and on publish (as with `originCity` and `description`) and masked by
  `publicText` on public responses.
- No user can create a public community or affect community pages. Custom
  trips never appear on community pages, so spam names cannot reach them.
- Auto-link only matches active communities, so an archived hub cannot be
  reached through a typed name.
- Notification titles stay fixed; the destination name is not copied into
  them.
- Free text splits discovery ("kasol" and "Kasol, HP" are different custom
  names). Auto-link limits this for places with a community.

## Out of scope

- Users creating or proposing communities.
- Destination text search, including custom names (owner decision 5).
- Linking existing custom trips when an admin later creates a matching
  community, and an admin list of popular custom names. Both are possible
  follow-ups.
- Alerts for custom destinations.
- Any change to budget, group size, date or transport validation.

## Acceptance criteria

- [ ] Migration applies on the current database; running
      `prisma migrate diff` again prints an empty migration.
- [ ] Raw SQL against the CHECK constraint: a linked row and a custom row are
      accepted; both NULL, both set, a custom name of `''` or spaces with no
      community, and a community with a `''` or spaces name are rejected.
- [ ] Create with `destinationName` (no matching community) returns `201` with
      the custom destination shape; read, edit, publish, `GET /trips`,
      `GET /trips/:tripId`, `GET /me/trips` and `GET /me/trip-memberships`
      show it.
- [ ] Auto-link, on create and on PATCH: a name equal to one active
      community's name in another case, with outer spaces, links it; two active
      communities with that name link none; one active plus one archived links
      the active one; an archived one alone links none; a slug-only match, a
      region-only match, "Manali, HP", and a name with doubled inner spaces
      keep the custom name. A custom name is stored trimmed.
- [ ] Create with `communityId` works as today.
- [ ] Create with neither or both returns `400 INVALID_DESTINATION`; a blank
      name returns `400 INVALID_DESTINATION`; 121 characters fails
      validation; 120 characters plus outer spaces fails validation; exactly
      120 characters is accepted; an unknown or archived `communityId` returns
      `400 INVALID_COMMUNITY`; a name with a phone number returns
      `400 PUBLIC_TEXT_PRIVACY_VIOLATION`.
- [ ] PATCH linked → custom clears `communityId`; custom → linked clears
      `destinationName`; PATCH with neither keeps the destination; both
      returns `400 INVALID_DESTINATION`; a stale `expectedVersion` still
      returns `409 TRIP_VERSION_CONFLICT`; a non-owner still gets `403`.
- [ ] Create without `description`, or with `"description": null`, stores
      `null` and returns `"description": null`; PATCH `description: null`
      clears it; PATCH without it keeps it; a string under 20 characters still
      fails.
- [ ] A stored custom name that fails the privacy check (inserted directly) is
      masked on public responses, shown as stored to the owner, and blocks
      publish with `400 PUBLIC_TEXT_PRIVACY_VIOLATION`.
- [ ] Publishing a custom trip succeeds and creates no
      `trip_publication_alerts` row; a linked trip still creates one. A linked
      trip published and then edited to custom before the worker runs sends no
      alert.
- [ ] Active members get one `TRIP_UPDATED` notice with the fixed title for
      each of linked → custom, custom → linked and custom → custom (Kasol →
      Tosh); the title never contains the name.
- [ ] Trip history shows `communityId` and `destinationName` before and after
      for linked → custom, custom → linked and custom → custom.
- [ ] Staff report detail for a reported custom trip with a `null` description
      shows the custom name; a moderator can remove the trip through the
      existing flow.
- [ ] A custom trip does not appear in `GET /communities/:slug/trips` or in
      `GET /trips?destination=<slug>`.
- [ ] A connection request on a custom trip, a request whose `relatedTrip` is
      custom, and the trip room return the custom destination without errors.
- [ ] The personal data export includes `destinationName`.
- [ ] Community follower, trip and post counts, merge and archive involve only
      linked trips; account erasure still cancels the owner's custom trips and
      updates memberships as today.
- [ ] A public profile's trip activity includes a published custom trip.
- [ ] Existing trip, community, connection, messaging, alert and profile tests
      pass unchanged, apart from fields that became nullable.
- [ ] Docs: README "Public trips API" and "Trip management" (destination
      rules, custom shape, optional description, per-person budget, simple
      example); `docs/backend-remaining-work.md`; `docs/roadmap.md` gets this
      row, and PR #61 on the duplicate-submission row, since merged items' PR
      numbers are added in the next item's branch.
- [ ] All checks in `AGENTS.md` pass, with complete output in root `*.log`
      files.

## Decisions for the owner

Decided on 2026-11-07: (1) build this item; (2) description optional, stored
as `null`, no generated text; (3) budget is per person; (4) auto-link exact
name matches to active communities, ignoring case; (5) defer destination text
search.

Also decided on 2026-11-07:

- **D1. Several active communities with the same name.** Names are not unique.
  Link none and keep the custom name; this only happens until an admin merges
  the duplicates.
- **D2. What auto-link compares.** The trimmed name against community `name`
  only, ignoring case; not the slug or region, and inner spaces are not
  collapsed. "manali" links; "Manali, HP" does not.
- **D3. Breaking response change for the Flutter app.** `description` and
  `destination.id`, `slug`, `region` and `countryCode` can be `null`. The
  owner tells the Flutter developer. After the build, the Builder writes a
  step-by-step Flutter integration guide in
  `docs/work/custom-trip-destinations/flutter-integration.md` listing every
  request and response change.
