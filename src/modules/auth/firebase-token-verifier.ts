import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { TokenVerifier, VerifiedIdentity } from './auth.types.js';

function firebaseAuth() {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      503,
      'AUTHENTICATION_UNAVAILABLE',
      'Authentication is not configured.',
    );
  }

  const app =
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      projectId: env.FIREBASE_PROJECT_ID,
    });

  return getAuth(app);
}

export const firebaseTokenVerifier: TokenVerifier = {
  async verify(token): Promise<VerifiedIdentity> {
    try {
      const decoded = await firebaseAuth().verifyIdToken(token);
      return {
        subject: decoded.uid,
        ...(decoded.name && { displayName: decoded.name }),
        ...(decoded.email && { email: decoded.email }),
        emailVerified: decoded.email_verified === true,
        ...(decoded.phone_number && { phoneNumber: decoded.phone_number }),
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
