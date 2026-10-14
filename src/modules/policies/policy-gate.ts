import { AppError } from '../../errors/app-error.js';
import type { PolicyType } from '../../generated/prisma/client.js';
import { listPolicyAcceptances } from './policy.repository.js';
import {
  currentAcceptanceStatus,
  type PolicyCatalog,
} from './policy.service.js';

export interface PolicyGate {
  // Rejects a user who has not accepted every current policy version. Does
  // nothing until the policy documents are configured.
  require(userId: string, activity: string): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    policyGate: PolicyGate;
  }
}

const policyNames: Record<PolicyType, string> = {
  TERMS: 'Terms of Service',
  PRIVACY: 'Privacy Notice',
  COMMUNITY_STANDARDS: 'Community Standards',
};

export function createPolicyGate(
  catalog: PolicyCatalog,
  loadAcceptances = listPolicyAcceptances,
): PolicyGate {
  return {
    async require(userId, activity) {
      if (!catalog) return;
      const missing = currentAcceptanceStatus(
        catalog,
        await loadAcceptances(userId),
      ).filter((policy) => policy.needsAcceptance);
      if (missing.length === 0) return;
      const names = missing.map((policy) => policyNames[policy.policyType]);
      throw new AppError(
        409,
        'POLICY_ACCEPTANCE_REQUIRED',
        `Accept the current ${names.join(', ')} before ${activity}.`,
      );
    },
  };
}
