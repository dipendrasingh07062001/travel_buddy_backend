import type { AuthenticatedUser } from './auth.types.js';

export function presentAuthenticatedUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
