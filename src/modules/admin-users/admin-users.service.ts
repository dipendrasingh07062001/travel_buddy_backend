import { AppError } from '../../errors/app-error.js';
import type {
  AccountRestriction,
  IdentityType,
} from '../../generated/prisma/client.js';
import type { SearchMatch } from './admin-users.types.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Error messages never repeat the searched text, so it cannot reach logs.
export function parseSearchQuery(
  raw: string | undefined,
): SearchMatch | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length < 2) {
    throw new AppError(
      400,
      'INVALID_USER_SEARCH',
      'A search must contain at least 2 non-space characters.',
    );
  }
  // Contacts must not travel in a URL, where proxies and browsers keep them.
  if (value.includes('@') || value.startsWith('+')) {
    throw new AppError(
      400,
      'USE_CONTACT_LOOKUP',
      'Search by email or phone with POST /api/v1/admin/users/lookup.',
    );
  }
  return uuidPattern.test(value)
    ? { kind: 'id', value: value.toLowerCase() }
    : { kind: 'name', value };
}

// Prisma passes `contains` to LIKE without escaping, so `%` and `_` would act
// as wildcards. PostgreSQL's default LIKE escape character is a backslash.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Matches how sign-in stores contacts (`verifiedContacts`).
export function normalizeContact(type: IdentityType, value: string): string {
  const trimmed = value.trim();
  return type === 'EMAIL' ? trimmed.toLowerCase() : trimmed;
}

// Unlike `isActive` in restriction.repository.ts, a restriction that starts
// in the future is not active yet.
export function isActiveRestriction(
  restriction: Pick<AccountRestriction, 'startsAt' | 'endsAt' | 'liftedAt'>,
  now: Date,
): boolean {
  return (
    restriction.liftedAt === null &&
    restriction.startsAt <= now &&
    (restriction.endsAt === null || restriction.endsAt > now)
  );
}

// Database errors can quote query arguments, so only the class name and the
// Prisma error code are kept.
export function safeFailure(error: unknown): {
  errorName: string;
  prismaCode?: string;
} {
  const name =
    typeof error === 'object' && error !== null
      ? (error.constructor as { name?: unknown } | undefined)?.name
      : undefined;
  const errorName = typeof name === 'string' && name ? name : 'Unknown';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' && /^P\d{4}$/.test(code)
    ? { errorName, prismaCode: code }
    : { errorName };
}
