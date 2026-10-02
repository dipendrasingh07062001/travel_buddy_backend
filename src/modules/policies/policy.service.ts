import type { PolicyType } from '@prisma/client';

import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

export const policyTypes = [
  'TERMS',
  'PRIVACY',
  'COMMUNITY_STANDARDS',
] as const satisfies readonly PolicyType[];

interface PolicyDocument {
  version: string;
  url: string;
}

export type PolicyCatalog = Readonly<Record<PolicyType, PolicyDocument>> | null;

interface AcceptanceRecord {
  policyType: PolicyType;
  version: string;
  acceptedAt: Date;
}

export function configuredPolicyCatalog(): PolicyCatalog {
  const {
    POLICY_TERMS_VERSION: termsVersion,
    POLICY_TERMS_URL: termsUrl,
    POLICY_PRIVACY_VERSION: privacyVersion,
    POLICY_PRIVACY_URL: privacyUrl,
    POLICY_COMMUNITY_STANDARDS_VERSION: standardsVersion,
    POLICY_COMMUNITY_STANDARDS_URL: standardsUrl,
  } = env;
  if (
    !termsVersion ||
    !termsUrl ||
    !privacyVersion ||
    !privacyUrl ||
    !standardsVersion ||
    !standardsUrl
  ) {
    return null;
  }
  return {
    TERMS: { version: termsVersion, url: termsUrl },
    PRIVACY: { version: privacyVersion, url: privacyUrl },
    COMMUNITY_STANDARDS: {
      version: standardsVersion,
      url: standardsUrl,
    },
  };
}

export function publicPolicies(catalog: PolicyCatalog) {
  return catalog
    ? policyTypes.map((policyType) => ({ policyType, ...catalog[policyType] }))
    : [];
}

export function currentAcceptanceStatus(
  catalog: PolicyCatalog,
  acceptances: AcceptanceRecord[],
) {
  return publicPolicies(catalog).map((policy) => {
    const accepted = acceptances.find(
      (record) =>
        record.policyType === policy.policyType &&
        record.version === policy.version,
    );
    return {
      ...policy,
      acceptedAt: accepted?.acceptedAt.toISOString() ?? null,
      needsAcceptance: !accepted,
    };
  });
}

export function requireCurrentPolicy(
  catalog: PolicyCatalog,
  policyType: PolicyType,
  version: string,
): void {
  if (!catalog) {
    throw new AppError(
      503,
      'POLICIES_UNAVAILABLE',
      'Approved policy documents have not been configured.',
    );
  }
  if (catalog[policyType].version !== version) {
    throw new AppError(
      409,
      'POLICY_VERSION_CHANGED',
      'This policy version is no longer current. Refresh the policy documents.',
    );
  }
}
