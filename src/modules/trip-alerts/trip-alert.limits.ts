import type { Prisma } from '../../generated/prisma/client.js';

// Matching alerts reach many people from one action, so both ends are capped.
// One account publishing many trips sends alerts for only its first few a day,
// and nobody receives more than a handful of matching alerts a day, however
// many accounts publish into their saved searches.
export const alertLimitWindowMs = 24 * 60 * 60 * 1000;
export const maximumAlertingPublicationsPerOwner = 5;
export const maximumMatchingAlertsPerRecipient = 10;

// Each quota check and the writes it allows run under a transaction-scoped
// advisory lock per account, so concurrent transactions take turns instead
// of all reading the same remaining quota. Only these quota paths take these
// locks, and they never wait for a row lock while holding one.
const ownerBudgetLockSpace = 7_201;
const recipientLimitLockSpace = 7_202;

// A 32-bit key from a random UUID's first eight hex digits. Two accounts that
// share a key only make each other's quota checks wait.
function lockKey(accountId: string): number {
  return Number.parseInt(accountId.slice(0, 8), 16) | 0;
}

export async function lockOwnerAlertBudget(
  transaction: Prisma.TransactionClient,
  ownerId: string,
): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${ownerBudgetLockSpace}::int4, ${lockKey(ownerId)}::int4)`;
}

// Locks are taken in ascending key order, so workers that need several
// recipients' locks at once cannot deadlock each other.
export async function lockRecipientAlertLimits(
  transaction: Prisma.TransactionClient,
  recipientIds: string[],
): Promise<void> {
  const keys = [...new Set(recipientIds.map(lockKey))].sort((a, b) => a - b);
  for (const key of keys) {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${recipientLimitLockSpace}::int4, ${key}::int4)`;
  }
}
