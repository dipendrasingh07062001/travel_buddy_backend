import { createPrivateKey } from 'node:crypto';

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

// Fixed texts only: parser and crypto errors can quote parts of the key.
export class FirebaseCredentialError extends Error {
  override name = 'FirebaseCredentialError';
}

export interface ServiceAccountCredential {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

// Checks the hosted secret offline. Whether Google still accepts the key (it
// may have been deleted or revoked) is only known when Firebase is called.
export function parseServiceAccount(
  secret: string,
  projectId: string,
): ServiceAccountCredential {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new FirebaseCredentialError(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
    );
  }
  const account = serviceAccountSchema.safeParse(value);
  if (!account.success) {
    throw new FirebaseCredentialError(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not a service account (type, project_id, client_email and private_key are required).',
    );
  }
  if (account.data.project_id !== projectId) {
    throw new FirebaseCredentialError(
      'FIREBASE_SERVICE_ACCOUNT_JSON project_id does not match FIREBASE_PROJECT_ID.',
    );
  }
  try {
    createPrivateKey(account.data.private_key);
  } catch {
    throw new FirebaseCredentialError(
      'FIREBASE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM private key.',
    );
  }
  return {
    projectId: account.data.project_id,
    clientEmail: account.data.client_email,
    privateKey: account.data.private_key,
  };
}

// Run at startup, so a malformed secret fails the deployment with a clear
// reason instead of passing the health check while every sign-in returns 503.
export function checkFirebaseCredentials(): void {
  const secret = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (secret === undefined || !env.FIREBASE_PROJECT_ID) return;
  parseServiceAccount(secret, env.FIREBASE_PROJECT_ID);
}

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
      return initializeApp({
        credential: cert(parseServiceAccount(secret, env.FIREBASE_PROJECT_ID)),
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
