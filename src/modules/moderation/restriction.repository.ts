import { database, databaseSchema } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import {
  Prisma,
  type AccountRestriction,
  type RestrictedFeature,
  type StaffRole,
} from '../../generated/prisma/client.js';
import {
  notifyAffectedUser,
  requireModeratableAccount,
  type Transaction,
} from './moderation-shared.js';

export const restrictedFeatures = [
  'CONNECTION_REQUESTS',
  'COMMUNITY_POSTING',
  'TRIP_PUBLISHING',
  'MESSAGING',
] as const satisfies readonly RestrictedFeature[];
export const maximumRestrictionDays = 90;
const day = 86_400_000;

const blockedActions: Record<RestrictedFeature, string> = {
  CONNECTION_REQUESTS: 'send connection requests',
  COMMUNITY_POSTING: 'post or comment in communities',
  TRIP_PUBLISHING: 'publish trips',
  MESSAGING: 'send or edit trip messages',
};

const usersTable = Prisma.raw(
  `"${databaseSchema.replace(/"/g, '""')}"."users"`,
);

export interface RestrictionInput {
  feature: RestrictedFeature;
  // Omitted: the restriction lasts until a moderator lifts it.
  durationDays?: number;
}

// A restriction is active until it is lifted or its end time passes.
function activeWhere(
  now: Date,
  userId?: string,
  feature?: RestrictedFeature,
): Prisma.AccountRestrictionWhereInput {
  return {
    ...(userId && { userId }),
    ...(feature && { feature }),
    liftedAt: null,
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
}

export function isActive(
  restriction: Pick<AccountRestriction, 'endsAt' | 'liftedAt'>,
  now = new Date(),
): boolean {
  return (
    restriction.liftedAt === null &&
    (restriction.endsAt === null || restriction.endsAt > now)
  );
}

/**
 * Rejects the action if the feature is restricted. Call it inside the
 * action's own transaction so the check and the write see the same state.
 */
export async function requireFeatureAllowed(
  tx: Transaction,
  userId: string,
  feature: RestrictedFeature,
  now = new Date(),
): Promise<void> {
  const restriction = await tx.accountRestriction.findFirst({
    where: activeWhere(now, userId, feature),
    select: { endsAt: true },
  });
  if (!restriction) return;
  const until = restriction.endsAt
    ? `until ${restriction.endsAt.toISOString()}`
    : 'until a moderator lifts the restriction';
  throw new AppError(
    403,
    'FEATURE_RESTRICTED',
    `Your account can't ${blockedActions[feature]} ${until}.`,
  );
}

// Locks the account row so restriction changes for one account apply one at
// a time, and checks the staff protections.
async function lockRestrictableAccount(
  tx: Transaction,
  userId: string,
  actorId: string,
  actorRole: StaffRole,
): Promise<void> {
  const [target] = await tx.$queryRaw<
    Array<{ staff_role: StaffRole; status: string }>
  >`SELECT staff_role, status FROM ${usersTable} WHERE id = ${userId}::uuid FOR UPDATE`;
  if (!target || target.status === 'DELETED') {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }
  requireModeratableAccount(userId, target.staff_role, actorId, actorRole);
}

/**
 * Restricts one feature and tells the account. The caller records the
 * moderation action, so a report resolution keeps a single audit entry.
 */
export async function applyRestriction(
  tx: Transaction,
  input: RestrictionInput & {
    userId: string;
    actorId: string;
    actorRole: StaffRole;
    reason: string;
    reportId?: string;
    now?: Date;
  },
): Promise<AccountRestriction> {
  const now = input.now ?? new Date();
  await lockRestrictableAccount(
    tx,
    input.userId,
    input.actorId,
    input.actorRole,
  );
  if (
    (await tx.accountRestriction.count({
      where: activeWhere(now, input.userId, input.feature),
    })) > 0
  ) {
    throw new AppError(
      409,
      'RESTRICTION_ACTIVE',
      'This feature is already restricted for this account. Lift that restriction before applying a new one.',
    );
  }
  const restriction = await tx.accountRestriction.create({
    data: {
      userId: input.userId,
      feature: input.feature,
      reason: input.reason,
      reportId: input.reportId ?? null,
      createdById: input.actorId,
      startsAt: now,
      endsAt: input.durationDays
        ? new Date(now.getTime() + input.durationDays * day)
        : null,
    },
  });
  await notifyAffectedUser(
    tx,
    {
      type: 'FEATURE_RESTRICTED',
      recipientId: input.userId,
      sourceId: restriction.id,
      eventKey: `restriction:${restriction.id}:applied`,
    },
    now,
  );
  return restriction;
}

export function restrictFeatureDirect(
  input: RestrictionInput & {
    userId: string;
    actorId: string;
    actorRole: StaffRole;
    reason: string;
  },
) {
  return database.$transaction(async (tx) => {
    const restriction = await applyRestriction(tx, input);
    await tx.moderationAction.create({
      data: {
        actorId: input.actorId,
        action: 'FEATURE_RESTRICTED',
        targetType: 'USER',
        targetId: input.userId,
        reason: input.reason,
      },
    });
    return restriction;
  });
}

export function liftRestriction(input: {
  restrictionId: string;
  actorId: string;
  actorRole: StaffRole;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return database.$transaction(async (tx) => {
    const restriction = await tx.accountRestriction.findUnique({
      where: { id: input.restrictionId },
      select: { userId: true },
    });
    if (!restriction) {
      throw new AppError(
        404,
        'RESTRICTION_NOT_FOUND',
        'Restriction not found.',
      );
    }
    await lockRestrictableAccount(
      tx,
      restriction.userId,
      input.actorId,
      input.actorRole,
    );
    const lifted = await tx.accountRestriction.updateMany({
      where: { id: input.restrictionId, ...activeWhere(now) },
      data: {
        liftedAt: now,
        liftedById: input.actorId,
        liftReason: input.reason,
      },
    });
    if (lifted.count !== 1) {
      throw new AppError(
        409,
        'RESTRICTION_NOT_ACTIVE',
        'This restriction has already ended or been lifted.',
      );
    }
    await tx.moderationAction.create({
      data: {
        actorId: input.actorId,
        action: 'FEATURE_RESTRICTION_LIFTED',
        targetType: 'USER',
        targetId: restriction.userId,
        reason: input.reason,
      },
    });
    await notifyAffectedUser(
      tx,
      {
        type: 'FEATURE_RESTRICTION_LIFTED',
        recipientId: restriction.userId,
        sourceId: input.restrictionId,
        eventKey: `restriction:${input.restrictionId}:lifted`,
      },
      now,
    );
    return tx.accountRestriction.findUniqueOrThrow({
      where: { id: input.restrictionId },
    });
  });
}

export function listAccountRestrictions(userId: string) {
  return database.accountRestriction.findMany({
    where: { userId },
    orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
  });
}

// What the restricted user may see: the feature and dates, never the reasons
// or the staff involved.
export function listActiveRestrictions(userId: string, now = new Date()) {
  return database.accountRestriction.findMany({
    where: activeWhere(now, userId),
    select: { id: true, feature: true, startsAt: true, endsAt: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
}
