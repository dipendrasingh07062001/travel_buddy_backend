import { firebaseTokenVerifier } from './firebase-token-verifier.js';
import { prismaAuthRepository } from './auth.repository.js';
import type { AuthRouteDependencies } from './auth.types.js';

export function resolveAuthDependencies(
  overrides: Partial<AuthRouteDependencies> = {},
): AuthRouteDependencies {
  return {
    tokenVerifier: overrides.tokenVerifier ?? firebaseTokenVerifier,
    repository: overrides.repository ?? prismaAuthRepository,
  };
}
