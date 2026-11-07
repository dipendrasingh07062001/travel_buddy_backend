# Flutter integration guide: custom trip destinations

For the Flutter developer. This describes exactly what changed in the API for
custom (typed) trip destinations and what the app needs to update. The rules
are in the README section "Trip management → Destination"; the full schemas
are at `/docs` on the running API.

## What changed, in one paragraph

A trip can now name **any** destination. Send either an existing community's
`communityId` or a typed `destinationName`, never both. If the typed name
equals the name of exactly one active community (ignoring case), the server
links that community for you. Users still cannot create communities, and no
community is created for a typed name. `description` is now optional. Every
trip response still has a `destination` object, but for a typed destination
its community fields are `null`, and `description` may be `null`.

## Step 1. Update your models (breaking)

These response fields can now be `null`. Make them nullable in every model
that reads a trip.

| Field                     | Before          | Now                                       |
| ------------------------- | --------------- | ----------------------------------------- |
| `destination.id`          | `String` (UUID) | `String?`, `null` for a typed destination |
| `destination.slug`        | `String`        | `String?`                                 |
| `destination.countryCode` | `String`        | `String?`                                 |
| `destination.region`      | `String?`       | `String?` (unchanged)                     |
| `destination.name`        | `String`        | `String` (always set)                     |
| `description`             | `String`        | `String?`                                 |

A suggested Dart shape:

```dart
class TripDestination {
  final String? id;          // null => typed destination
  final String? slug;        // null => typed destination
  final String name;         // always present; display this
  final String? region;
  final String? countryCode;

  bool get isCommunity => id != null;
}
```

Where these appear:

| Endpoint                                                                                                                  | Destination shape                     | `description` nullable            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| `POST /trips`, `PATCH /trips/:id`, `POST /trips/:id/{publish,pause,mark-full,cancel,complete}`                            | full object above                     | yes                               |
| `GET /trips`, `GET /trips/:id`, `GET /me/trips`, `GET /me/trip-memberships`, `GET /communities/:slug/trips`               | full object above                     | yes                               |
| `GET /users/:userId/trips` (profile cards)                                                                                | full object above                     | (no description field, as before) |
| `GET /trips/:id/room` (`data.plan`)                                                                                       | full object above                     | yes                               |
| Connection requests (`trip` and `relatedTrip`), e.g. `POST /trips/:id/connection-requests`, `GET /me/connection-requests` | `{ "slug": String?, "name": String }` | (no description field, as before) |

Not changed: the `community` object on community posts and comments, and the
community endpoints themselves, are always real communities and never `null`.

## Step 2. Create a trip

Typed destination (the simple form):

```json
POST /api/v1/trips
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

A selected suggestion: send `"communityId": "<uuid>"` instead of
`destinationName`. Never send placeholder ids.

Response `201`, the parts that matter here:

```json
{
  "data": {
    "id": "…",
    "destination": {
      "id": null,
      "slug": null,
      "name": "Kasol",
      "region": null,
      "countryCode": null
    },
    "description": null,
    "budget": {
      "minimum": "5000.00",
      "maximum": "12000.00",
      "currency": "INR"
    },
    "group": { "currentSize": 1, "desiredSize": 4, "availableSpaces": 3 },
    "dateMode": "EXACT",
    "durationDays": 8,
    "transport": "UNDECIDED",
    "status": "DRAFT",
    "version": 1
  }
}
```

Things to know:

- **Auto-link.** If the user types "manali" and an active community is named
  "Manali", the response comes back **linked** (`destination.id` set, the
  community's `slug`, `region` and `countryCode`). Always render the
  destination from the response, not from what was typed. "Manali, HP" or a
  name with extra inner spaces is not linked; it stays typed.
- **You can drop the compatibility fields.** The server defaults omitted
  fields on create: `dateMode: EXACT`, `flexibilityDays: 0`,
  `weekendsOnly: false`, `transport: UNDECIDED`, currency `INR`, and
  `durationDays` from the dates. Sending them is still accepted.
- **Stop generating a description.** Omit `description` (or send `null`); the
  trip stores `null`. If you send one, it must be 20–2000 characters.
- **Budget** is an approximate amount **per person** in INR. Label it that way.
  Send numbers, or `null` for blanks. Responses return amounts as strings with
  two decimals, as before.
- **Group size**: `desiredGroupSize` is total capacity including the owner,
  1–100. Do not send `currentGroupSize` from the simple form; it starts at 1
  and changes as members join and leave.
- Publishing is unchanged: after creating the draft, call
  `POST /trips/:id/publish` with `{ "expectedVersion": 1,
"confirmsPersonalPlan": true }`.

## Step 3. Edit a trip

`PATCH /api/v1/trips/:id` with the latest `expectedVersion`:

| You send                  | Result                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| `destinationName: "Tosh"` | typed destination; any community link is cleared (or auto-linked, above) |
| `communityId: "<uuid>"`   | linked; any typed name is cleared                                        |
| neither                   | destination unchanged                                                    |
| both                      | `400 INVALID_DESTINATION`, nothing changes                               |
| `description: null`       | description cleared                                                      |
| no `description`          | description unchanged                                                    |
| any other field left out  | unchanged (create defaults are **not** applied on edit)                  |

Recommendations:

- **Send the destination only when the user changed it.** Any destination field
  in a PATCH counts as a plan change, so every member gets a "Trip plan
  updated" notice even if the value is the same.
- To prefill the edit form: if `destination.id` is `null`, show
  `destination.name` as typed text; otherwise show the selected community.
- Keep sending advanced values only if the user changed them; the server keeps
  saved values for omitted fields.
- `desiredGroupSize` below the current group size returns
  `400 INVALID_GROUP_SIZE`, as before.

## Step 4. Handle the errors

All errors use the usual body `{ "error": { "code", "message", "requestId" } }`.

| Code                                | When                                                                                                    | Suggested UI                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `400 INVALID_DESTINATION` (new)     | create with neither field; both fields; `destinationName` empty or only spaces                          | "Choose or type a destination"         |
| `400 INVALID_COMMUNITY`             | `communityId` unknown or archived                                                                       | refresh suggestions, ask to pick again |
| `400 REQUEST_ERROR`                 | `destinationName` longer than 120 characters (counted before trimming); description under 20 characters | limit the field to 120 characters      |
| `400 PUBLIC_TEXT_PRIVACY_VIOLATION` | the destination name (or other public text) contains contact details such as a phone number             | "Remove contact details"               |
| `409 TRIP_VERSION_CONFLICT`         | stale `expectedVersion` (unchanged)                                                                     | reload the trip and retry              |
| `404 COMMUNITY_NOT_FOUND`           | rare: the community was archived at the moment of saving                                                | refresh suggestions                    |

## Step 5. Display rules

- Show `destination.name` everywhere. For a typed destination there is no
  community page: do not link to `/communities/:slug`, and hide "follow" or
  "view community" actions when `slug` is `null`.
- Public responses may show `[Hidden for privacy]` as the name if a stored name
  fails the privacy check. The owner sees the original in owner responses
  (`/me/trips`, create and edit) and can correct it.
- Treat `description: null` as "no description" (hide the section).

## Step 6. Lists and search

- Trips with a typed destination appear in `GET /trips`, trip details, My
  Trips, memberships, profile cards, connection requests and trip rooms.
- They **never** appear in `GET /communities/:slug/trips`, and
  `GET /trips?destination=<slug>` matches linked trips only.
- Searching by typed destination name is **not** available yet (deferred to a
  later item). Keep destination search based on community suggestions for now.
- Saved trip alerts follow communities, so publishing a typed-destination trip
  does not alert anyone.

## Step 7. Test checklist for the app

- [ ] Create with a typed name not in the suggestions, publish, see it in
      Explore, details, My Trips and the profile.
- [ ] Type an existing community's name in other letter case: the trip comes
      back linked.
- [ ] Edit linked → typed, typed → linked, typed → another typed, and an edit
      that changes neither.
- [ ] Empty name, both fields, over 120 characters, and a phone number in the
      name each show the right message.
- [ ] Trips with no description render without errors on every screen,
      including the trip room.
- [ ] Connection request and trip room screens for a typed-destination trip.
- [ ] Older linked trips still look and behave as before.

## Rollout

The database migration and the API ship together. Until the new backend is
deployed, the old backend rejects `destinationName` and requires
`communityId` and `description`, so release the app change only after the
backend is live.
