import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';
import { database } from '../../database/client.js';
import { firebaseApp } from '../auth/firebase-app.js';
import type { EmailRecipientResolver } from './email.types.js';

interface CurrentFirebaseAccount {
  disabled: boolean;
  emailVerified: boolean;
  email?: string;
}

export function createFirebaseEmailRecipientResolver(
  lookup: (uid: string) => Promise<CurrentFirebaseAccount> = (uid) =>
    getAuth(firebaseApp()).getUser(uid),
): EmailRecipientResolver {
  return {
    async resolve(userId) {
      const account = await database.authAccount.findFirst({
        where: {
          userId,
          provider: 'FIREBASE',
          user: { status: 'ACTIVE', deletedAt: null },
        },
        select: { providerSubject: true },
      });
      if (!account) return null;
      try {
        const current = await lookup(account.providerSubject);
        const parsed = z.email().safeParse(current.email?.trim());
        return !current.disabled && current.emailVerified && parsed.success
          ? parsed.data
          : null;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        if (code === 'auth/user-not-found' || code === 'auth/user-disabled')
          return null;
        // Callers translate this to a generic retry; no provider error text in
        // logs, HTTP responses or the outbox (which could include an address).
        // eslint-disable-next-line preserve-caught-error -- Raw provider causes can contain recipient addresses or credentials.
        throw new Error('EMAIL_RECIPIENT_LOOKUP_UNAVAILABLE');
      }
    },
  };
}
