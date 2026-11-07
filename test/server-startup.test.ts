import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Starts the real entry point with broken hosted credentials and checks that it
// stops before listening, says why, and never prints the secret.
const marker = 'SYNTHETIC_STARTUP_SECRET_MUST_NOT_LEAK';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const childDeadline = 120_000;
const unparseableKey = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\n`;
const account = {
  type: 'service_account',
  project_id: 'travel-buddy-test',
  client_email: 'test@travel-buddy-test.iam.gserviceaccount.com',
  private_key: unparseableKey,
};
const notAServiceAccount =
  'FIREBASE_SERVICE_ACCOUNT_JSON is not a service account (type, project_id, client_email and private_key are required).';

const credentialCases = [
  {
    name: 'invalid JSON',
    secret: `{"private_key":"${marker}"`,
    message: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
  },
  {
    name: 'a wrong type',
    secret: JSON.stringify({ ...account, type: 'authorized_user' }),
    message: notAServiceAccount,
  },
  {
    name: 'a missing client_email',
    secret: JSON.stringify({ ...account, client_email: undefined }),
    message: notAServiceAccount,
  },
  {
    name: 'a different project_id',
    secret: JSON.stringify({ ...account, project_id: 'different-project' }),
    message:
      'FIREBASE_SERVICE_ACCOUNT_JSON project_id does not match FIREBASE_PROJECT_ID.',
  },
  {
    name: 'an unparseable private_key',
    secret: JSON.stringify(account),
    message:
      'FIREBASE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM private key.',
  },
];
// Over the 65 536-character limit, so env.ts rejects it before server.ts runs.
const oversizedSecret = `${'x'.repeat(65_537)}${marker}`;

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  spawnError: string | undefined;
}

const children = new Set<ChildProcess>();
let temporaryDirectory: string;
let emptyEnvFile: string;

// Built from scratch so no developer setting, NODE_OPTIONS or .env value can
// change which startup path runs.
function childEnvironment(secret: string): Record<string, string> {
  const environment: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    PORT: '3999',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
    PUSH_NOTIFICATIONS_ENABLED: 'false',
    FIREBASE_PROJECT_ID: 'travel-buddy-test',
    FIREBASE_SERVICE_ACCOUNT_JSON: secret,
    DOTENV_CONFIG_PATH: emptyEnvFile,
  };
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toLowerCase();
    if ((name === 'path' || name === 'systemroot') && value !== undefined)
      environment[key] = value;
  }
  return environment;
}

function startServer(secret: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts'],
      {
        cwd: repositoryRoot,
        env: childEnvironment(secret),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let output = '';
    let timedOut = false;
    let spawnError: string | undefined;
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, childDeadline);
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal, output, timedOut, spawnError });
    });
  });
}

const outcomes = new Map<string, Outcome>();

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'travel-buddy-startup-'));
  emptyEnvFile = join(temporaryDirectory, 'empty.env');
  writeFileSync(emptyEnvFile, '');
  const runs = [
    ...credentialCases.map(({ name, secret }) => ({ name, secret })),
    { name: 'oversized', secret: oversizedSecret },
  ];
  const results = await Promise.all(
    runs.map(async ({ name, secret }) => [name, await startServer(secret)]),
  );
  for (const [name, outcome] of results as [string, Outcome][])
    outcomes.set(name, outcome);
  // Six starts run together. In full unit runs each took up to 35 s on a
  // 4-core machine, and a busier machine went past 45 s, so each child gets
  // 120 s. The extra hook time lets a slow child be reported by the timedOut
  // assertion; if killing a child stalls, the hook timeout fails instead.
}, childDeadline + 30_000);

afterAll(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function expectStoppedCleanly(outcome: Outcome | undefined): Outcome {
  expect(outcome).toBeDefined();
  const result = outcome as Outcome;
  expect(result.spawnError).toBeUndefined();
  expect(result.timedOut).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.code).toBe(1);
  expect(result.output).not.toContain('Server listening');
  expect(result.output).not.toContain(marker);
  return result;
}

describe('server startup with hosted Firebase credentials', () => {
  it.each(credentialCases)(
    'stops before listening on $name without printing the secret',
    ({ name, message }) => {
      const { output } = expectStoppedCleanly(outcomes.get(name));
      expect(output).toContain(message);
      expect(output).toContain('API failed to start');
    },
  );

  it('rejects an oversized secret in the environment check without printing it', () => {
    const { output } = expectStoppedCleanly(outcomes.get('oversized'));
    expect(output).toContain('Invalid environment configuration');
    expect(output).not.toContain('API failed to start');
  });
});
