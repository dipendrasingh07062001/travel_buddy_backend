import { inspect } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  env: {
    FIREBASE_PROJECT_ID: 'travel-buddy-test' as string | undefined,
    FIREBASE_SERVICE_ACCOUNT_JSON: undefined as string | undefined,
  },
  applicationDefault: vi.fn(),
  cert: vi.fn(),
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({ env: fixture.env }));
vi.mock('firebase-admin/app', () => ({
  applicationDefault: fixture.applicationDefault,
  cert: fixture.cert,
  getApps: fixture.getApps,
  initializeApp: fixture.initializeApp,
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: fixture.verifyIdToken }),
}));

import { AppError } from '../src/errors/app-error.js';
import { firebaseApp } from '../src/modules/auth/firebase-app.js';
import { firebaseTokenVerifier } from '../src/modules/auth/firebase-token-verifier.js';

const privateMarker = 'SYNTHETIC_PRIVATE_KEY_MUST_NOT_LEAK';
const privateKey = `-----BEGIN PRIVATE KEY-----\n${privateMarker}\n-----END PRIVATE KEY-----\n`;
const account = {
  type: 'service_account',
  project_id: 'travel-buddy-test',
  client_email: 'test@travel-buddy-test.iam.gserviceaccount.com',
  private_key: privateKey,
};
const app = { name: '[DEFAULT]' };
const adc = { kind: 'adc' };
const hosted = { kind: 'hosted' };

beforeEach(() => {
  vi.resetAllMocks();
  fixture.env.FIREBASE_PROJECT_ID = 'travel-buddy-test';
  fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = undefined;
  fixture.getApps.mockReturnValue([]);
  fixture.applicationDefault.mockReturnValue(adc);
  fixture.cert.mockReturnValue(hosted);
  fixture.initializeApp.mockReturnValue(app);
});

function expectSanitizedFailure() {
  let failure: unknown;
  try {
    firebaseApp();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({
    statusCode: 503,
    code: 'AUTHENTICATION_UNAVAILABLE',
    message: 'Authentication is not configured correctly.',
  });
  expect(inspect(failure, { depth: null, showHidden: true })).not.toContain(
    privateMarker,
  );
  expect(failure).not.toHaveProperty('cause');
}

describe('Firebase Admin credential initialization', () => {
  it('preserves ADC file/workload-identity support when the hosted secret is unset', () => {
    expect(firebaseApp()).toBe(app);
    expect(fixture.applicationDefault).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.cert).not.toHaveBeenCalled();
    expect(fixture.initializeApp).toHaveBeenCalledExactlyOnceWith({
      credential: adc,
      projectId: 'travel-buddy-test',
    });
  });

  it('loads the original hosted JSON and only forwards allowlisted fields', () => {
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      ...account,
      token_uri: 'https://untrusted.invalid/token',
      extra: privateMarker,
    });
    expect(firebaseApp()).toBe(app);
    expect(fixture.applicationDefault).not.toHaveBeenCalled();
    expect(fixture.cert).toHaveBeenCalledExactlyOnceWith({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey,
    });
    expect(fixture.initializeApp).toHaveBeenCalledExactlyOnceWith({
      credential: hosted,
      projectId: 'travel-buddy-test',
    });
  });

  it('reuses the existing Admin instance rather than parsing the key on every request', () => {
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    fixture.getApps.mockReturnValueOnce([]).mockReturnValue([app]);
    expect(firebaseApp()).toBe(app);
    expect(firebaseApp()).toBe(app);
    expect(fixture.cert).toHaveBeenCalledTimes(1);
    expect(fixture.initializeApp).toHaveBeenCalledTimes(1);
  });

  it('requires a project ID even if an SDK app already exists', () => {
    fixture.env.FIREBASE_PROJECT_ID = undefined;
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    fixture.getApps.mockReturnValue([app]);
    expect(firebaseApp).toThrowError(
      expect.objectContaining({
        statusCode: 503,
        code: 'AUTHENTICATION_UNAVAILABLE',
      }),
    );
    expect(fixture.getApps).not.toHaveBeenCalled();
    expect(fixture.cert).not.toHaveBeenCalled();
    expect(fixture.applicationDefault).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'an empty JSON string', raw: '' },
    { name: 'whitespace instead of JSON', raw: '   ' },
    { name: 'malformed JSON', raw: `{"private_key":"${privateMarker}"` },
    { name: 'a JSON path instead of JSON', raw: '/run/secrets/firebase.json' },
    { name: 'null', raw: 'null' },
    { name: 'an array', raw: JSON.stringify([account]) },
    {
      name: 'a JSON-encoded string',
      raw: JSON.stringify(JSON.stringify(account)),
    },
    {
      name: 'a missing type',
      raw: JSON.stringify({ ...account, type: undefined }),
    },
    {
      name: 'a user credential',
      raw: JSON.stringify({ ...account, type: 'authorized_user' }),
    },
    {
      name: 'a missing email',
      raw: JSON.stringify({ ...account, client_email: undefined }),
    },
    {
      name: 'an invalid email',
      raw: JSON.stringify({ ...account, client_email: 'not-an-email' }),
    },
    {
      name: 'a missing private key',
      raw: JSON.stringify({ ...account, private_key: undefined }),
    },
    {
      name: 'an empty private key',
      raw: JSON.stringify({ ...account, private_key: '' }),
    },
    {
      name: 'a missing project',
      raw: JSON.stringify({ ...account, project_id: undefined }),
    },
    {
      name: 'a different project',
      raw: JSON.stringify({ ...account, project_id: 'different-test-project' }),
    },
  ])(
    'rejects $name without falling back to ADC or leaking the secret',
    ({ raw }) => {
      fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = raw;
      expectSanitizedFailure();
      expect(fixture.applicationDefault).not.toHaveBeenCalled();
      expect(fixture.cert).not.toHaveBeenCalled();
      expect(fixture.initializeApp).not.toHaveBeenCalled();
    },
  );

  it('sanitizes SDK private-key validation errors without retaining the cause', () => {
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    fixture.cert.mockImplementation(() => {
      throw new Error(`Invalid private key: ${privateMarker}`);
    });
    expectSanitizedFailure();
    expect(fixture.applicationDefault).not.toHaveBeenCalled();
    expect(fixture.initializeApp).not.toHaveBeenCalled();
  });

  it('sanitizes hosted SDK initialization errors', () => {
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    fixture.initializeApp.mockImplementation(() => {
      throw new Error(privateMarker);
    });
    expectSanitizedFailure();
    expect(fixture.applicationDefault).not.toHaveBeenCalled();
  });

  it('sanitizes ADC file/credential errors', () => {
    fixture.applicationDefault.mockImplementation(() => {
      throw new Error(privateMarker);
    });
    expectSanitizedFailure();
    expect(fixture.cert).not.toHaveBeenCalled();
    expect(fixture.initializeApp).not.toHaveBeenCalled();
  });

  it('keeps a fresh token check unavailable when hosted credentials are invalid', async () => {
    fixture.env.FIREBASE_SERVICE_ACCOUNT_JSON = `{"private_key":"${privateMarker}"`;
    await expect(
      firebaseTokenVerifier.verify('synthetic-id-token', {
        checkRevoked: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'AUTHENTICATION_UNAVAILABLE',
    });
    expect(fixture.verifyIdToken).not.toHaveBeenCalled();
    expect(fixture.applicationDefault).not.toHaveBeenCalled();
  });
});
