import { database } from '../../database/client.js';
import type {
  Prisma,
  RestrictedFeature,
} from '../../generated/prisma/client.js';
import { escapeLike, isActiveRestriction } from './admin-users.service.js';
import type {
  AdminUserRepository,
  AdminUserSearch,
  AdminUserSummary,
} from './admin-users.types.js';

type Client = Prisma.TransactionClient | typeof database;

const summarySelect = {
  id: true,
  displayName: true,
  status: true,
  staffRole: true,
  createdAt: true,
  profile: { select: { profilePhotoStorageKey: true } },
} satisfies Prisma.UserSelect;

type SummaryRow = Prisma.UserGetPayload<{ select: typeof summarySelect }>;

const lookupReasons = {
  EMAIL: 'Staff looked up an account by email.',
  PHONE: 'Staff looked up an account by phone.',
} as const;

function searchWhere(input: AdminUserSearch): Prisma.UserWhereInput {
  return {
    status: input.status ?? { not: 'DELETED' },
    ...(input.staffRole && { staffRole: input.staffRole }),
    ...(input.match?.kind === 'id' && { id: input.match.value }),
    ...(input.match?.kind === 'name' && {
      displayName: {
        contains: escapeLike(input.match.value),
        mode: 'insensitive',
      },
    }),
  };
}

// Restrictions and open reports for one page of accounts, in two queries.
async function summarize(
  client: Client,
  rows: SummaryRow[],
  now = new Date(),
): Promise<AdminUserSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  // Sequential, because an interactive transaction runs one query at a time.
  const restrictions = await client.accountRestriction.findMany({
    where: {
      userId: { in: ids },
      liftedAt: null,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    select: {
      userId: true,
      feature: true,
      startsAt: true,
      endsAt: true,
      liftedAt: true,
    },
  });
  const reports = await client.report.groupBy({
    by: ['reportedUserId'],
    where: {
      reportedUserId: { in: ids },
      status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
    },
    _count: { _all: true },
  });
  const features = new Map<string, Set<RestrictedFeature>>();
  for (const restriction of restrictions) {
    if (!isActiveRestriction(restriction, now)) continue;
    const set = features.get(restriction.userId) ?? new Set();
    set.add(restriction.feature);
    features.set(restriction.userId, set);
  }
  const reportCounts = new Map<string, number>();
  for (const group of reports) {
    if (group.reportedUserId) {
      reportCounts.set(group.reportedUserId, group._count._all);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    staffRole: row.staffRole,
    createdAt: row.createdAt,
    hasProfilePhoto: Boolean(row.profile?.profilePhotoStorageKey),
    activeRestrictions: [...(features.get(row.id) ?? [])].sort(),
    openReportCount: reportCounts.get(row.id) ?? 0,
  }));
}

export const prismaAdminUserRepository: AdminUserRepository = {
  async search(input) {
    const where = searchWhere(input);
    const [rows, totalItems] = await database.$transaction([
      database.user.findMany({
        where,
        select: summarySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      database.user.count({ where }),
    ]);
    return { users: await summarize(database, rows), totalItems };
  },

  async lookup(input) {
    return database.$transaction(async (tx) => {
      const identity = await tx.authIdentity.findUnique({
        where: {
          type_normalizedValue: {
            type: input.type,
            normalizedValue: input.value,
          },
        },
        select: { userId: true },
      });
      if (!identity) return null;
      // The audit row comes first: if it cannot be written, nothing is shown.
      await tx.moderationAction.create({
        data: {
          actorId: input.actorId,
          action: 'USER_LOOKED_UP',
          targetType: 'USER',
          targetId: identity.userId,
          reason: lookupReasons[input.type],
        },
      });
      const row = await tx.user.findUnique({
        where: { id: identity.userId },
        select: summarySelect,
      });
      if (!row) return null;
      const [summary] = await summarize(tx, [row]);
      return summary ?? null;
    });
  },
};
