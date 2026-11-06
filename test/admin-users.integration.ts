import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import { prismaAdminUserRepository } from '../src/modules/admin-users/admin-users.repository.js';
import type { AdminUserRepository } from '../src/modules/admin-users/admin-users.types.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const run = randomUUID().slice(0, 8);
const marker = `AUS${run}`;
const day = 86_400_000;

const accounts = [
  'admin',
  'moderator',
  'user',
  'suspendedStaff',
  'pendingStaff',
  'demoted',
  'logStaff',
  'rateSearch',
  'rateLookup',
  'tieA',
  'tieB',
  'photo',
  'noPhoto',
  'noProfile',
  'suspended',
  'deleted',
  'percent',
  'fifty',
  'underscore',
  'axb',
  'backslash',
  'restricted',
  'emailOwner',
  'phoneOwner',
  'secret',
] as const;
type Account = (typeof accounts)[number];
const ids = Object.fromEntries(
  accounts.map((account) => [account, randomUUID()]),
) as Record<Account, string>;
const subject = (account: Account) => `admin-users-${run}-${account}`;

const email = `aus-${run}@example.com`;
const sentEmail = `  AUS-${run.toUpperCase()}@Example.COM `;
const suspendedEmail = `aus-suspended-${run}@example.com`;
const deletedEmail = `aus-deleted-${run}@example.com`;
const phone = `+9199${String(randomInt(10_000_000, 99_999_999))}`;
const secretName = `${marker}-secretname`;

const staffAccounts = new Set<Account>([
  'moderator',
  'suspendedStaff',
  'pendingStaff',
  'demoted',
  'logStaff',
  'rateSearch',
  'rateLookup',
]);

const tokenVerifier: TokenVerifier = {
  async verify(token, options) {
    if (token === 'invalid') {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    }
    // Valid locally, so the rate limiter accepts it, but revoked in Firebase.
    if (token === 'revoked') {
      if (options?.checkRevoked) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Token revoked.');
      }
      return { subject: subject('moderator'), emailVerified: false };
    }
    return { subject: subject(token as Account), emailVerified: false };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });

// A second app captures logs and lets each test choose how the repository
// behaves. It also has its own rate-limit store.
interface LogLine {
  msg: string;
  reqId?: string;
  req?: { url?: string };
  err?: unknown;
  event?: string;
  staffId?: string;
  contactType?: string;
  outcome?: string;
  errorName?: string;
  prismaCode?: string;
}
const logText: string[] = [];
const logLines: LogLine[] = [];
const stream = new Writable({
  write(chunk, _encoding, callback) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      logText.push(line);
      logLines.push(JSON.parse(line) as LogLine);
    }
    callback();
  },
});
let mode: 'real' | 'empty' | 'failSearch' | 'failLookup' | 'auditFail' = 'real';
const switchable: AdminUserRepository = {
  async search(input) {
    if (mode === 'empty') return { users: [], totalItems: 0 };
    if (mode === 'failSearch') {
      throw new Error(`Invalid query: contains "${secretName}"`);
    }
    return prismaAdminUserRepository.search(input);
  },
  async lookup(input) {
    if (mode === 'empty') return null;
    if (mode === 'failLookup') {
      throw new Error(`Invalid query: normalizedValue "${input.value}"`);
    }
    if (mode === 'auditFail') {
      // No account has this ID, so the audit insert fails its foreign key.
      return prismaAdminUserRepository.lookup({
        ...input,
        actorId: randomUUID(),
      });
    }
    return prismaAdminUserRepository.lookup(input);
  },
};
const logApp = buildApp({
  logger: { level: 'info', stream },
  auth: { tokenVerifier },
  adminUsers: { repository: switchable },
});

function search(token: string, query = '', target = app) {
  return target.inject({
    method: 'GET',
    url: `/api/v1/admin/users${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function lookup(token: string, payload: object, target = app) {
  return target.inject({
    method: 'POST',
    url: '/api/v1/admin/users/lookup',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const markerQuery = `?query=${encodeURIComponent(marker)}&pageSize=100`;
const missLookup = { type: 'EMAIL', value: `nobody-${run}@example.com` };

interface Item {
  id: string;
  displayName: string | null;
  status: string;
  staffRole: string;
  createdAt: string;
  hasProfilePhoto: boolean;
  activeRestrictions: string[];
  openReportCount: number;
}

function dataOf(response: { json(): unknown }): Item[] {
  return (response.json() as { data: Item[] }).data;
}

function lookedUpCount(where: { targetId?: string; actorId?: string }) {
  return database.moderationAction.count({
    where: { action: 'USER_LOOKED_UP', ...where },
  });
}

beforeAll(async () => {
  // Fixtures are dated in the future so they lead the default listing.
  const base = Date.now() + 10 * day;
  const createdAt: Partial<Record<Account, Date>> = {
    tieA: new Date(base),
    tieB: new Date(base),
  };
  accounts.forEach((account, index) => {
    createdAt[account] ??= new Date(base - (index + 1) * 60_000);
  });
  const names: Partial<Record<Account, string | null>> = {
    percent: `${marker}-50%-off`,
    fifty: `${marker}-50ab`,
    underscore: `${marker}-a_b`,
    axb: `${marker}-axb`,
    backslash: `${marker}-c\\d`,
    secret: secretName,
    deleted: null,
  };
  for (const account of accounts) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName:
          account in names ? names[account]! : `${marker}-${account}`,
        status:
          account === 'suspendedStaff' || account === 'suspended'
            ? 'SUSPENDED'
            : account === 'pendingStaff'
              ? 'PENDING_DELETION'
              : account === 'deleted'
                ? 'DELETED'
                : 'ACTIVE',
        statusBeforeDeletion: account === 'pendingStaff' ? 'ACTIVE' : null,
        deletedAt: account === 'deleted' ? new Date() : null,
        staffRole:
          account === 'admin'
            ? 'ADMIN'
            : staffAccounts.has(account)
              ? 'MODERATOR'
              : 'USER',
        createdAt: createdAt[account]!,
        ...(account !== 'noProfile' &&
          account !== 'deleted' && {
            profile: {
              create:
                account === 'photo'
                  ? { profilePhotoStorageKey: `profile-photos/${run}.webp` }
                  : {},
            },
          }),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(account) },
        },
      },
    });
  }
  await database.authIdentity.createMany({
    data: (
      [
        { userId: ids.emailOwner, type: 'EMAIL', normalizedValue: email },
        { userId: ids.phoneOwner, type: 'PHONE', normalizedValue: phone },
        {
          userId: ids.suspended,
          type: 'EMAIL',
          normalizedValue: suspendedEmail,
        },
      ] as const
    ).map((identity) => ({ ...identity, verifiedAt: new Date() })),
  });

  const now = Date.now();
  const restriction = (
    feature:
      | 'CONNECTION_REQUESTS'
      | 'COMMUNITY_POSTING'
      | 'TRIP_PUBLISHING'
      | 'MESSAGING',
    startsAt: number,
    endsAt: number | null,
    lifted = false,
  ) => ({
    userId: ids.restricted,
    feature,
    reason: 'Integration fixture restriction.',
    createdById: ids.moderator,
    startsAt: new Date(startsAt),
    endsAt: endsAt === null ? null : new Date(endsAt),
    ...(lifted && {
      liftedAt: new Date(now - day),
      liftedById: ids.moderator,
      liftReason: 'Integration fixture lift.',
    }),
  });
  await database.accountRestriction.createMany({
    data: [
      restriction('MESSAGING', now - day, null),
      restriction('MESSAGING', now - day, now + day),
      restriction('COMMUNITY_POSTING', now - day, now + 2 * day),
      restriction('TRIP_PUBLISHING', now - 2 * day, null, true),
      restriction('CONNECTION_REQUESTS', now - 10 * day, now - day),
      restriction('CONNECTION_REQUESTS', now + day, null),
      restriction('TRIP_PUBLISHING', now + day, now + 2 * day),
    ],
  });
  await database.report.createMany({
    data: (
      [
        ['admin', 'SUBMITTED'],
        ['moderator', 'UNDER_REVIEW'],
        ['admin', 'ACTIONED'],
        ['user', 'DISMISSED'],
      ] as const
    ).map(([reporter, status]) => ({
      reporterId: ids[reporter],
      targetType: 'USER' as const,
      reportedUserId: ids.restricted,
      reason: 'HARASSMENT' as const,
      status,
      ...(status === 'UNDER_REVIEW' && { reviewerId: ids.moderator }),
    })),
  });
  await app.ready();
  await logApp.ready();
});

afterAll(async () => {
  await app.close();
  await logApp.close();
  const userIds = Object.values(ids);
  await database.moderationAction.deleteMany({
    where: {
      OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
    },
  });
  await database.accountRestriction.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.report.deleteMany({
    where: { reporterId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('admin user routes: access', () => {
  async function both(token: string) {
    return [await search(token, markerQuery), await lookup(token, missLookup)];
  }

  it('rejects missing, invalid and revoked tokens', async () => {
    for (const response of [
      await app.inject({ method: 'GET', url: '/api/v1/admin/users' }),
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/users/lookup',
        payload: missLookup,
      }),
      ...(await both('invalid')),
      ...(await both('revoked')),
    ]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects ordinary, suspended and pending-deletion accounts', async () => {
    const cases: Array<[Account, string]> = [
      ['user', 'STAFF_ONLY'],
      ['suspendedStaff', 'ACCOUNT_SUSPENDED'],
      ['pendingStaff', 'ACCOUNT_DELETION_PENDING'],
    ];
    for (const [account, code] of cases) {
      for (const response of await both(account)) {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe(code);
      }
    }
  });

  it('allows moderators and administrators', async () => {
    for (const account of ['moderator', 'admin'] as const) {
      for (const response of await both(account)) {
        expect(response.statusCode).toBe(200);
      }
    }
  });

  it('stops access on the next request after the role is removed', async () => {
    for (const response of await both('demoted')) {
      expect(response.statusCode).toBe(200);
    }
    await database.user.update({
      where: { id: ids.demoted },
      data: { staffRole: 'USER' },
    });
    for (const response of await both('demoted')) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('STAFF_ONLY');
    }
  });
});

describe('GET /admin/users', () => {
  it('lists non-deleted accounts newest first with a stable tie-break', async () => {
    const response = await search('moderator', '?pageSize=100');

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const ours = dataOf(response)
      .map((item) => item.id)
      .filter((id) => Object.values(ids).includes(id));
    const [first, second] = [ids.tieA, ids.tieB].sort().reverse();
    expect(ours.slice(0, 2)).toEqual([first, second]);
    expect(ours).not.toContain(ids.deleted);
    expect(ours).toContain(ids.suspended);
    const fixtureTimes = dataOf(response)
      .filter((item) => ours.includes(item.id))
      .map((item) => item.createdAt);
    expect(fixtureTimes).toEqual([...fixtureTimes].sort().reverse());
  });

  it('returns the standard pagination and an empty page past the end', async () => {
    const all = await search('moderator', markerQuery);
    const total = (all.json() as { pagination: { totalItems: number } })
      .pagination.totalItems;
    expect(total).toBe(accounts.length - 1);

    const response = await search(
      'moderator',
      `?query=${marker}&page=1000&pageSize=1`,
    );
    expect(response.json()).toEqual({
      data: [],
      pagination: {
        page: 1000,
        pageSize: 1,
        totalItems: total,
        totalPages: total,
      },
    });
  });

  it('matches an exact account ID in any letter case', async () => {
    const response = await search(
      'moderator',
      `?query=${ids.photo.toUpperCase()}`,
    );
    expect(dataOf(response).map((item) => item.id)).toEqual([ids.photo]);

    const miss = await search('moderator', `?query=${randomUUID()}`);
    expect(dataOf(miss)).toEqual([]);
  });

  it('matches part of a display name case-insensitively', async () => {
    const response = await search(
      'moderator',
      `?query=${marker.toLowerCase()}-TIE`,
    );
    expect(
      dataOf(response)
        .map((item) => item.id)
        .sort(),
    ).toEqual([ids.tieA, ids.tieB].sort());
  });

  it('treats %, _ and \\ as literal characters', async () => {
    const cases: Array<[string, Account]> = [
      [`${marker}-50%`, 'percent'],
      [`${marker}-a_b`, 'underscore'],
      [`${marker}-c\\d`, 'backslash'],
    ];
    for (const [query, account] of cases) {
      const response = await search(
        'moderator',
        `?query=${encodeURIComponent(query)}`,
      );
      expect(dataOf(response).map((item) => item.id)).toEqual([ids[account]]);
    }
  });

  it('filters by status and role, alone and with a query', async () => {
    const suspended = await search(
      'moderator',
      `${markerQuery}&status=SUSPENDED`,
    );
    expect(
      dataOf(suspended)
        .map((item) => item.id)
        .sort(),
    ).toEqual([ids.suspended, ids.suspendedStaff].sort());

    const staff = await search(
      'moderator',
      `${markerQuery}&staffRole=MODERATOR&status=ACTIVE`,
    );
    const staffIds = dataOf(staff).map((item) => item.id);
    expect(staffIds).toContain(ids.moderator);
    expect(staffIds).not.toContain(ids.suspendedStaff);
    expect(dataOf(staff).every((item) => item.staffRole === 'MODERATOR')).toBe(
      true,
    );

    const admins = await search('moderator', '?staffRole=ADMIN&pageSize=100');
    expect(dataOf(admins).map((item) => item.id)).toContain(ids.admin);
    expect(dataOf(admins).every((item) => item.staffRole === 'ADMIN')).toBe(
      true,
    );
  });

  it('shows deleted accounts only when asked for', async () => {
    expect(dataOf(await search('moderator', `?query=${ids.deleted}`))).toEqual(
      [],
    );
    const response = await search(
      'moderator',
      `?query=${ids.deleted}&status=DELETED`,
    );
    expect(dataOf(response)).toMatchObject([
      { id: ids.deleted, displayName: null, status: 'DELETED' },
    ]);
  });

  it('returns only the allowed fields, with photo, restriction and report summaries', async () => {
    const response = await search('moderator', markerQuery);
    const items = new Map(dataOf(response).map((item) => [item.id, item]));
    for (const item of items.values()) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'activeRestrictions',
          'createdAt',
          'displayName',
          'hasProfilePhoto',
          'id',
          'openReportCount',
          'staffRole',
          'status',
        ].sort(),
      );
    }
    expect(items.get(ids.photo)?.hasProfilePhoto).toBe(true);
    expect(items.get(ids.noPhoto)?.hasProfilePhoto).toBe(false);
    expect(items.get(ids.noProfile)?.hasProfilePhoto).toBe(false);
    expect(items.get(ids.restricted)).toMatchObject({
      activeRestrictions: ['COMMUNITY_POSTING', 'MESSAGING'],
      openReportCount: 2,
    });
    expect(items.get(ids.photo)).toMatchObject({
      activeRestrictions: [],
      openReportCount: 0,
    });
    expect(response.body).not.toContain(email);
    expect(response.body).not.toContain('Integration fixture');
    expect(response.body).not.toContain('profile-photos/');
  });

  it('validates the query', async () => {
    const cases: Array<[string, number, string]> = [
      ['?query=a', 400, 'INVALID_USER_SEARCH'],
      ['?query=%20%20a%20%20', 400, 'INVALID_USER_SEARCH'],
      ['?query=%20%20%20', 400, 'INVALID_USER_SEARCH'],
      ['?query=priya%40example.com', 400, 'USE_CONTACT_LOOKUP'],
      ['?query=%2B919876', 400, 'USE_CONTACT_LOOKUP'],
      ['?query=', 400, 'REQUEST_ERROR'],
      [`?query=${'x'.repeat(101)}`, 400, 'REQUEST_ERROR'],
      ['?page=0', 400, 'REQUEST_ERROR'],
      ['?pageSize=101', 400, 'REQUEST_ERROR'],
      ['?status=GONE', 400, 'REQUEST_ERROR'],
    ];
    for (const [query, status, code] of cases) {
      const response = await search('moderator', query);
      expect(response.statusCode, query).toBe(status);
      expect(response.json().error.code, query).toBe(code);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const forbidden = await search('user', markerQuery);
    expect(forbidden.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /admin/users/lookup', () => {
  it('finds the owner of a stored email or phone and records the lookup', async () => {
    const before = await lookedUpCount({ targetId: ids.emailOwner });
    const response = await lookup('moderator', {
      type: 'EMAIL',
      value: sentEmail,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data).toMatchObject({
      id: ids.emailOwner,
      status: 'ACTIVE',
    });
    expect(response.body.toLowerCase()).not.toContain(email);
    const actions = await database.moderationAction.findMany({
      where: { action: 'USER_LOOKED_UP', targetId: ids.emailOwner },
    });
    expect(actions).toHaveLength(before + 1);
    expect(actions.at(-1)).toMatchObject({
      actorId: ids.moderator,
      targetType: 'USER',
      reason: 'Staff looked up an account by email.',
    });

    const byPhone = await lookup('admin', {
      type: 'PHONE',
      value: ` ${phone} `,
    });
    expect(byPhone.json().data.id).toBe(ids.phoneOwner);
    const phoneAction = await database.moderationAction.findFirst({
      where: { action: 'USER_LOOKED_UP', targetId: ids.phoneOwner },
    });
    expect(phoneAction?.reason).toBe('Staff looked up an account by phone.');
    expect(phoneAction?.reason).not.toContain(phone);
  });

  it('returns null and records nothing when no stored contact matches', async () => {
    const before = await lookedUpCount({ actorId: ids.moderator });
    for (const payload of [
      missLookup,
      // Erasure deletes a deleted account's identities.
      { type: 'EMAIL', value: deletedEmail },
      { type: 'PHONE', value: '+910000000000' },
    ]) {
      const response = await lookup('moderator', payload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: null });
    }
    expect(await lookedUpCount({ actorId: ids.moderator })).toBe(before);
  });

  it('finds a suspended account', async () => {
    const response = await lookup('moderator', {
      type: 'EMAIL',
      value: suspendedEmail,
    });
    expect(response.json().data).toMatchObject({
      id: ids.suspended,
      status: 'SUSPENDED',
    });
  });

  it('validates the body', async () => {
    for (const payload of [
      { type: 'NAME', value: email },
      { type: 'EMAIL' },
      { type: 'EMAIL', value: 'ab' },
      { type: 'EMAIL', value: `${'x'.repeat(309)}@example.com` },
    ]) {
      const response = await lookup('moderator', payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_ERROR');
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('admin user routes: logs, failures and limits', () => {
  const secrets = [
    email,
    sentEmail.trim(),
    phone,
    secretName,
    suspendedEmail,
  ].flatMap((value) => [value, encodeURIComponent(value)]);

  function lookupLines(account: Account) {
    return logLines.filter(
      (line) =>
        line.event === 'admin_user_lookup' && line.staffId === ids[account],
    );
  }

  it('keeps names and contacts out of logs on success and rejection', async () => {
    mode = 'real';
    const hit = await lookup(
      'logStaff',
      { type: 'EMAIL', value: sentEmail },
      logApp,
    );
    expect(hit.json().data.id).toBe(ids.emailOwner);
    const miss = await lookup(
      'logStaff',
      { type: 'PHONE', value: '+910000000001' },
      logApp,
    );
    expect(miss.json().data).toBeNull();
    const invalid = await lookup(
      'logStaff',
      { type: 'NAME', value: sentEmail },
      logApp,
    );
    expect(invalid.statusCode).toBe(400);
    const unauthorised = await lookup(
      'user',
      { type: 'EMAIL', value: suspendedEmail },
      logApp,
    );
    expect(unauthorised.statusCode).toBe(403);
    const named = await search(
      'logStaff',
      `?query=${encodeURIComponent(secretName)}`,
      logApp,
    );
    expect(dataOf(named).map((item) => item.id)).toEqual([ids.secret]);

    const incoming = logLines.filter(
      (line) =>
        line.msg === 'incoming request' &&
        line.req?.url?.startsWith('/api/v1/admin/users'),
    );
    expect(incoming.length).toBeGreaterThanOrEqual(5);
    for (const line of incoming) {
      expect(line.reqId).toBeTruthy();
      expect(line.req?.url).not.toContain('?');
    }
    expect(lookupLines('logStaff').map((line) => line.outcome)).toEqual([
      'hit',
      'miss',
    ]);
    expect(lookupLines('user')).toEqual([]);
  });

  it('replaces failing reads and audit writes with a fixed 500', async () => {
    mode = 'failLookup';
    const failedRead = await lookup(
      'logStaff',
      { type: 'EMAIL', value: sentEmail },
      logApp,
    );
    expect(failedRead.statusCode).toBe(500);
    expect(failedRead.headers['cache-control']).toBe('no-store');
    expect(failedRead.json().data).toBeUndefined();

    mode = 'auditFail';
    const before = await lookedUpCount({ targetId: ids.phoneOwner });
    const failedAudit = await lookup(
      'logStaff',
      { type: 'PHONE', value: phone },
      logApp,
    );
    expect(failedAudit.statusCode).toBe(500);
    expect(failedAudit.body).not.toContain(ids.phoneOwner);
    expect(await lookedUpCount({ targetId: ids.phoneOwner })).toBe(before);

    mode = 'failSearch';
    const failedSearch = await search(
      'logStaff',
      `?query=${encodeURIComponent(secretName)}`,
      logApp,
    );
    expect(failedSearch.statusCode).toBe(500);
    expect(failedSearch.headers['cache-control']).toBe('no-store');
    mode = 'real';

    const failures = logLines.filter(
      (line) => line.event === 'admin_user_query_failed',
    );
    expect(failures).toHaveLength(3);
    for (const line of failures) {
      expect(line.err).toBeUndefined();
      expect(line.errorName).toBeTruthy();
    }
    expect(failures[1]).toMatchObject({
      errorName: 'PrismaClientKnownRequestError',
      prismaCode: 'P2003',
    });
    expect(lookupLines('logStaff').map((line) => line.outcome)).toEqual([
      'hit',
      'miss',
      'failed',
      'failed',
    ]);
  });

  it('limits searches to 60 a minute per account', async () => {
    mode = 'empty';
    for (let index = 0; index < 60; index += 1) {
      expect((await search('rateSearch', '', logApp)).statusCode).toBe(200);
    }
    const limited = await search(
      'rateSearch',
      `?query=${encodeURIComponent(secretName)}`,
      logApp,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    mode = 'real';
  });

  it('limits lookups to 20 a minute per account', async () => {
    mode = 'empty';
    for (let index = 0; index < 20; index += 1) {
      expect((await lookup('rateLookup', missLookup, logApp)).statusCode).toBe(
        200,
      );
    }
    const limited = await lookup(
      'rateLookup',
      { type: 'EMAIL', value: sentEmail },
      logApp,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    mode = 'real';
    expect(lookupLines('rateLookup')).toHaveLength(20);
  });

  it('never logged a searched name or contact', () => {
    const text = logText.join('\n');
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain(email);
  });
});
