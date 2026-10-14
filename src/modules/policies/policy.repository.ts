import { database } from '../../database/client.js';
import type { PolicyType } from '../../generated/prisma/client.js';

export function listPolicyAcceptances(userId: string) {
  return database.policyAcceptance.findMany({
    where: { userId },
    select: { policyType: true, version: true, acceptedAt: true },
  });
}

export function acceptPolicyVersion(
  userId: string,
  policyType: PolicyType,
  version: string,
) {
  return database.policyAcceptance.upsert({
    where: { userId_policyType_version: { userId, policyType, version } },
    create: { userId, policyType, version },
    update: {},
    select: { policyType: true, version: true, acceptedAt: true },
  });
}
