import { getAuth } from 'firebase-admin/auth';

import { AppError } from '../../errors/app-error.js';
import type { TokenVerifier, VerifiedIdentity } from './auth.types.js';
import { firebaseApp } from './firebase-app.js';

export const firebaseTokenVerifier: TokenVerifier = {
  async verify(token): Promise<VerifiedIdentity> {
    try {
      const decoded = await getAuth(firebaseApp()).verifyIdToken(token);
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
      if (code?.startsWith('auth/')) {
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
