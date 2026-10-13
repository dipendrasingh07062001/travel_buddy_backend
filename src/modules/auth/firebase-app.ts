import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';

import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

// One Firebase Admin app serves token verification and push delivery.
// Verifying ID tokens needs only the project ID; sending push messages also
// needs Google credentials (GOOGLE_APPLICATION_CREDENTIALS or the host's
// workload identity).
export function firebaseApp(): App {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      503,
      'AUTHENTICATION_UNAVAILABLE',
      'Authentication is not configured.',
    );
  }

  return (
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      projectId: env.FIREBASE_PROJECT_ID,
    })
  );
}
