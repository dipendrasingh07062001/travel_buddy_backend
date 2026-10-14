import type { FastifyRequest } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import type {
  AuthenticatedUser,
  AuthRouteDependencies,
  TokenVerifier,
  VerifiedIdentity,
} from './auth.types.js';

function bearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'A Bearer authentication token is required.',
    );
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'The Authorization header must use the Bearer scheme.',
    );
  }
  return match[1];
}

async function verifyBearerIdentity(
  request: FastifyRequest,
  verifier: TokenVerifier,
): Promise<VerifiedIdentity> {
  const identity = await verifier.verify(
    bearerToken(request.headers.authorization),
  );
  if (!identity.subject || identity.subject.length > 128) {
    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'The authentication token contains an invalid subject.',
    );
  }
  return identity;
}

// The rate limiter verifies the token to key limits by account, so the result
// is cached per request to avoid verifying it a second time in the handler.
const verifiedIdentities = new WeakMap<
  FastifyRequest,
  Promise<VerifiedIdentity>
>();

export function verifyRequestIdentity(
  request: FastifyRequest,
  verifier: TokenVerifier,
): Promise<VerifiedIdentity> {
  let identity = verifiedIdentities.get(request);
  if (!identity) {
    identity = verifyBearerIdentity(request, verifier);
    verifiedIdentities.set(request, identity);
  }
  return identity;
}

export function requireActiveUser(user: AuthenticatedUser): AuthenticatedUser {
  if (user.status === 'PENDING_DELETION') {
    throw new AppError(
      403,
      'ACCOUNT_DELETION_PENDING',
      'This account is scheduled for deletion. Cancel the deletion request to use it again.',
    );
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(
      403,
      'ACCOUNT_DISABLED',
      'This account is not permitted to access the application.',
    );
  }
  return user;
}

export async function authenticateRequest(
  request: FastifyRequest,
  dependencies: AuthRouteDependencies,
): Promise<AuthenticatedUser> {
  return requireActiveUser(
    await authenticateRequestIncludingSuspended(request, dependencies),
  );
}

export async function authenticateRequestIncludingSuspended(
  request: FastifyRequest,
  dependencies: AuthRouteDependencies,
): Promise<AuthenticatedUser> {
  const identity = await verifyRequestIdentity(
    request,
    dependencies.tokenVerifier,
  );
  const user = await dependencies.repository.findFirebaseUser(identity.subject);
  if (!user) {
    throw new AppError(
      403,
      'ACCOUNT_NOT_PROVISIONED',
      'Create the local account before accessing this resource.',
    );
  }
  if (user.status === 'DELETED') {
    throw new AppError(
      403,
      'ACCOUNT_DISABLED',
      'This account is not permitted to access this resource.',
    );
  }
  return user;
}

export async function authenticateRequestIfPresent(
  request: FastifyRequest,
  dependencies: AuthRouteDependencies,
): Promise<AuthenticatedUser | null> {
  if (!request.headers.authorization) return null;
  return authenticateRequest(request, dependencies);
}

// Rate limits apply per account for requests with a valid token, so users who
// share an IP address (mobile carrier NAT, an office, a load balancer without
// trustProxy) do not share limits. Other requests are limited per IP address.
export async function rateLimitKey(
  request: FastifyRequest,
  verifier: TokenVerifier,
): Promise<string> {
  if (request.headers.authorization) {
    try {
      const identity = await verifyRequestIdentity(request, verifier);
      return `account:${identity.subject}`;
    } catch {
      // The route handler reports the authentication error.
    }
  }
  return `ip:${request.ip}`;
}
