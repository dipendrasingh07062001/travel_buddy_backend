import { getAuth } from 'firebase-admin/auth';

import type { SignInAccountRemover } from '../account-deletion/account-cleanup.js';
import { firebaseApp } from './firebase-app.js';

// Deleting a Firebase user needs Google credentials, like push delivery.
export const firebaseSignInAccounts: SignInAccountRemover = {
  async remove(subject) {
    try {
      await getAuth(firebaseApp()).deleteUser(subject);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code !== 'auth/user-not-found') throw error;
    }
  },
};
