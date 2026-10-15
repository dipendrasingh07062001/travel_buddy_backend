import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyIdToken, deleteUser } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken, deleteUser }),
}));
vi.mock('../src/modules/auth/firebase-app.js', () => ({
  firebaseApp: () => ({}),
}));

import { firebaseSignInAccounts } from '../src/modules/auth/firebase-sign-in-accounts.js';
import { firebaseTokenVerifier } from '../src/modules/auth/firebase-token-verifier.js';

beforeEach(() => vi.resetAllMocks());

describe('Firebase account deletion protections', () => {
  it('checks revoked/deleted accounts and preserves the original sign-in time', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'person',
      auth_time: 1_700_000_000,
    });
    const identity = await firebaseTokenVerifier.verify('id-token');
    expect(verifyIdToken).toHaveBeenCalledWith('id-token', true);
    expect(identity.authTime).toEqual(new Date(1_700_000_000_000));
  });

  it.each([
    'auth/id-token-revoked',
    'auth/user-not-found',
    'auth/user-disabled',
  ])('rejects a token when Firebase reports %s', async (code) => {
    verifyIdToken.mockRejectedValue({ code });
    await expect(
      firebaseTokenVerifier.verify('id-token'),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it.each([
    'auth/internal-error',
    'auth/insufficient-permission',
    'app/invalid-credential',
  ])(
    'reports Firebase service/configuration failure %s as unavailable',
    async (code) => {
      verifyIdToken.mockRejectedValue({ code });
      await expect(
        firebaseTokenVerifier.verify('id-token'),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'AUTHENTICATION_UNAVAILABLE',
      });
    },
  );

  it('treats an already deleted Firebase account as successful cleanup', async () => {
    deleteUser.mockRejectedValue({ code: 'auth/user-not-found' });
    await expect(
      firebaseSignInAccounts.remove('person'),
    ).resolves.toBeUndefined();
  });

  it('propagates provider failures so cleanup can retry', async () => {
    const error = new Error('Provider unavailable');
    deleteUser.mockRejectedValue(error);
    await expect(firebaseSignInAccounts.remove('person')).rejects.toBe(error);
  });
});
