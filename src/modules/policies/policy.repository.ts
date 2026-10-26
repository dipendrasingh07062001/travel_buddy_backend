import { database } from '../../database/client.js';
import type { PolicyType } from '../../generated/prisma/client.js';

export function listPolicyAcceptances(userId: string) {
  return database.policyAcceptance.findMany({
    where: { userId },
    select: { policyType: true, version: true, acceptedAt: true },
  });
}

// Prisma's upsert here reads before inserting, so simultaneous duplicate
// submissions raced into a unique-key error. ON CONFLICT DO NOTHING is atomic,
// and reading afterwards returns the first acceptance and its timestamp.
export async function acceptPolicyVersion(
  userId: string,
  policyType: PolicyType,
  version: string,
) {
  await database.policyAcceptance.createMany({
    data: { userId, policyType, version },
    skipDuplicates: true,
  });
  return database.policyAcceptance.findUniqueOrThrow({
    where: { userId_policyType_version: { userId, policyType, version } },
    select: { policyType: true, version: true, acceptedAt: true },
  });
}
