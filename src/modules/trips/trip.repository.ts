import { database, databaseSchema } from '../../database/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { normalizeTripSearchQuery } from './trip-search.query.js';
import {
  publicTripInclude,
  publicTripStatuses,
  utcStartOfToday,
  type ResolvedListTripsQuery,
  type TripRepository,
} from './trip.types.js';

// Identifiers cannot be bound as values. Only the server-configured schema
// and these fixed identifiers go through raw SQL; search input is parameterized.
function identifier(name: 'trips' | 'users' | 'communities' | 'TripTransport') {
  return Prisma.raw(`"${databaseSchema.replace(/"/g, '""')}"."${name}"`);
}

function searchOrder(query: ResolvedListTripsQuery): Prisma.Sql {
  if (query.sort === 'departure_asc') {
    return Prisma.sql`"start_date" ASC, "id" ASC`;
  }
  if (query.sort === 'date_overlap') {
    const from = query.departureFrom;
    const to = query.departureTo;
    if (!from || !to) throw new Error('A validated date window is required.');
    // Shared days count at most the trip's own length, so a wide date window
    // cannot outrank an exact trip that fits the search. For exact trips the
    // length equals the range, so the cap changes nothing.
    return Prisma.sql`
      LEAST("duration_days", GREATEST(0, LEAST("end_date", ${to}::date)
        - GREATEST("start_date", ${from}::date) + 1)) DESC,
      (ABS("start_date" - ${from}::date) + ABS("end_date" - ${to}::date)) ASC,
      "start_date" ASC, "id" ASC
    `;
  }
  return Prisma.sql`"published_at" DESC, "id" ASC`;
}

interface SearchPage {
  total_items: bigint;
  ids: string[];
}

export const prismaTripRepository: TripRepository = {
  async listPublic(input) {
    const query = normalizeTripSearchQuery(input);
    const today = utcStartOfToday().toISOString().slice(0, 10);
    const from =
      query.departureFrom && query.departureFrom > today
        ? query.departureFrom
        : today;
    const filters: Prisma.Sql[] = [
      Prisma.sql`t."status" IN ('PUBLISHED', 'FULL')`,
      Prisma.sql`t."moderation_removed_at" IS NULL`,
      Prisma.sql`u."status" = 'ACTIVE' AND u."deleted_at" IS NULL`,
      Prisma.sql`c."status" = 'ACTIVE'`,
      Prisma.sql`t."end_date" >= ${from}::date`,
    ];
    if (query.origin)
      filters.push(Prisma.sql`t."origin_city" ILIKE ${`%${query.origin}%`}`);
    if (query.destination)
      filters.push(Prisma.sql`c."slug" = ${query.destination}`);
    if (query.departureTo)
      filters.push(Prisma.sql`t."start_date" <= ${query.departureTo}::date`);
    if (query.minBudget !== undefined)
      filters.push(
        Prisma.sql`t."budget_max" >= ${query.minBudget.toString()}::numeric`,
      );
    if (query.maxBudget !== undefined)
      filters.push(
        Prisma.sql`t."budget_min" <= ${query.maxBudget.toString()}::numeric`,
      );
    if (query.minDuration !== undefined)
      filters.push(Prisma.sql`t."duration_days" >= ${query.minDuration}`);
    if (query.maxDuration !== undefined)
      filters.push(Prisma.sql`t."duration_days" <= ${query.maxDuration}`);
    if (query.transport)
      filters.push(
        Prisma.sql`t."transport" = CAST(${query.transport} AS ${identifier('TripTransport')})`,
      );
    if (query.availableOnly)
      filters.push(
        Prisma.sql`t."status" = 'PUBLISHED' AND t."current_group_size" < t."desired_group_size"`,
      );

    // Rank and paginate in PostgreSQL, never after fetching a page. Count and
    // IDs use the same filtered set, including for an empty/out-of-range page.
    // Hydration shares the snapshot, so concurrent moderation/deletion cannot
    // produce a mixture of two different visibility states in one response.
    return database.$transaction(
      async (tx) => {
        const [page] = await tx.$queryRaw<SearchPage[]>`
          WITH matching_trips AS NOT MATERIALIZED (
          SELECT t."id", t."start_date", t."end_date", t."duration_days",
            t."published_at"
          FROM ${identifier('trips')} t
          JOIN ${identifier('users')} u ON u."id" = t."owner_id"
          JOIN ${identifier('communities')} c ON c."id" = t."community_id"
          WHERE ${Prisma.join(filters, ' AND ')}
        )
        SELECT (SELECT COUNT(*) FROM matching_trips) AS "total_items",
          ARRAY(SELECT "id" FROM matching_trips
            ORDER BY ${searchOrder(query)}
            LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}) AS "ids"
      `;
        if (!page) throw new Error('Trip search did not return a result page.');
        const totalItems = Number(page.total_items);
        if (!Number.isSafeInteger(totalItems))
          throw new Error('Trip count exceeds safe pagination range.');
        if (page.ids.length === 0) return { trips: [], totalItems };
        const trips = await tx.trip.findMany({
          where: { id: { in: page.ids } },
          include: publicTripInclude,
        });
        const byId = new Map(trips.map((trip) => [trip.id, trip]));
        return {
          totalItems,
          trips: page.ids.map((id) => {
            const trip = byId.get(id);
            if (!trip)
              throw new Error('Trip is missing from the search snapshot.');
            return trip;
          }),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 10_000,
      },
    );
  },

  findPublicById(id) {
    return database.trip.findFirst({
      where: {
        id,
        status: { in: [...publicTripStatuses] },
        moderationRemovedAt: null,
        owner: { status: 'ACTIVE', deletedAt: null },
        community: { status: 'ACTIVE' },
      },
      include: publicTripInclude,
    });
  },
};
