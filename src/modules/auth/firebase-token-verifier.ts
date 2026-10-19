import { getAuth } from 'firebase-admin/auth';

import { AppError } from '../../errors/app-error.js';
import type { TokenVerifier, VerifiedIdentity } from './auth.types.js';
import { firebaseApp } from './firebase-app.js';

const rejectedTokenCodes = new Set([
  'auth/argument-error',
  'auth/invalid-argument',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/user-disabled',
  'auth/user-not-found',
  'auth/tenant-id-mismatch',
]);

export const firebaseTokenVerifier: TokenVerifier = {
  async verify(token, options): Promise<VerifiedIdentity> {
    try {
      // The signature and expiry are checked against Google's public keys.
      // With checkRevoked, Firebase is also asked whether the account still
      // exists, is enabled and has not had its sessions revoked; that needs
      // Admin credentials. Any failure to ask fails closed with a 503.
      const decoded = await getAuth(firebaseApp()).verifyIdToken(
        token,
        options?.checkRevoked === true,
      );
      return {
        subject: decoded.uid,
        ...(decoded.name && { displayName: decoded.name }),
        ...(decoded.email && { email: decoded.email }),
        emailVerified: decoded.email_verified === true,
        ...(decoded.phone_number && { phoneNumber: decoded.phone_number }),
        authTime: new Date(decoded.auth_time * 1000),
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;
      if (code && rejectedTokenCodes.has(code)) {
        throw new AppError(
          401,
          'UNAUTHENTICATED',
          'The authentication token is invalid or expired.',
        );
      }
      throw new AppError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'Authentication is temporarily unavailable.',
      );
    }
  },
};
