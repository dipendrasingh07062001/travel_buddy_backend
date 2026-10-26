# Home discovery

The home screen shows separate sections for upcoming trips, destination
communities and recent community posts (PRD §4.1). This milestone adds the two
public lists that were missing. It needs no migration, provider or API key, and
does not change any existing response.

| Home section        | Endpoint                                          |
| ------------------- | ------------------------------------------------- |
| Upcoming trips      | `GET /api/v1/trips?sort=departure_asc` (existing) |
| Popular communities | `GET /api/v1/communities?sort=activity`           |
| Recent posts        | `GET /api/v1/community-posts`                     |

A mixed trips-and-posts timeline is not provided: the agreed home design uses
separate sections, and recency ordering inside each section is already
transparent.

## Recent posts across communities

`GET /api/v1/community-posts` is public. Optional query parameters:

- `community`: one destination slug. A merged slug resolves to its current
  community; an unknown or archived slug returns `404 COMMUNITY_NOT_FOUND`.
- `type`: `DISCUSSION`, `QUESTION` or `EXPERIENCE`.
- `page` (default 1) and `pageSize` (default 20, maximum 100).

Posts are ordered newest published first, then by ID. Each item has the same
fields as `GET /communities/:slug/posts`, plus `community` (`id`, `slug`,
`name`, `region`, `countryCode`) so a card can name its destination.

The same visibility rules as the per-community list apply:

- only `PUBLISHED`, non-removed posts in `ACTIVE` communities;
- authors must be active, not deleted, and have public community activity;
- a signed-in viewer does not see posts from accounts they blocked or that
  blocked them;
- titles, bodies and display names are masked by the
  [public-text rules](public-text-privacy.md).

## Community activity sort

`GET /api/v1/communities` keeps `sort=name` as the default. `sort=activity`
orders active communities by:

1. most upcoming public trips (`activity.upcomingTrips`);
2. then most public posts (`activity.posts`);
3. then name, then ID.

These are the same counts returned in each community's `activity` object, so
the order can be explained from what the screen shows. Follower counts are
deliberately not used: the PRD avoids follower-count popularity (§15.2).

Communities are created by administrators, so the active set is ranked in
memory using the existing count queries. Revisit this with a SQL ranking if
the number of active communities grows into the thousands.

## Tests

- `test/communities.test.ts`: query validation, defaults and response shape.
- `test/community-discovery.integration.ts`: ordering, destination and type
  filters, merged slugs, pagination, archived communities, suspended, deleted
  and private authors, removed and draft posts, blocks in both directions,
  text masking, and the activity order with ties.
