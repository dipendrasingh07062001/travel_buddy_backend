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

export async function verifyRequestIdentity(
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

export function requireActiveUser(user: AuthenticatedUser): AuthenticatedUser {
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
  return requireActiveUser(user);
}
