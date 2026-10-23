import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().trim().min(1),
  client_email: z.email(),
  private_key: z.string().min(1),
});

// One Firebase Admin app serves token verification, push delivery and
// sign-in account deletion. Local token checks need only the project ID;
// fresh account checks on sensitive actions, push messages and account
// deletion also need Google credentials: a hosted JSON secret, an ADC file
// selected by GOOGLE_APPLICATION_CREDENTIALS, or the host's workload identity.
export function firebaseApp(): App {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new AppError(
      503,
      'AUTHENTICATION_UNAVAILABLE',
      'Authentication is not configured.',
    );
  }

  try {
    const existing = getApps()[0];
    if (existing) return existing;

    const secret = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (secret !== undefined) {
      const account = serviceAccountSchema.parse(JSON.parse(secret));
      if (account.project_id !== env.FIREBASE_PROJECT_ID) {
        throw new Error('Firebase service account project does not match.');
      }
      return initializeApp({
        credential: cert({
          projectId: account.project_id,
          clientEmail: account.client_email,
          privateKey: account.private_key,
        }),
        projectId: env.FIREBASE_PROJECT_ID,
      });
    }

    return initializeApp({
      credential: applicationDefault(),
      projectId: env.FIREBASE_PROJECT_ID,
    });
  } catch {
    // JSON/parser/SDK errors can contain credential fragments, file paths or
    // private-key causes. Do not retain the raw error or silently try ADC after
    // an explicitly configured hosted secret fails.
    throw new AppError(
      503,
      'AUTHENTICATION_UNAVAILABLE',
      'Authentication is not configured correctly.',
    );
  }
}
