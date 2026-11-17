import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import {
  completeAccessRequest,
  type DataRequestCompletionHooks,
} from '../src/modules/data-requests/data-request.repository.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const run = randomUUID().slice(0, 8);

// Each group of cases has its own administrator, so no group can use up the
// route's limit of 20 requests a minute for another.
const admins = [
  'adminAuth',
  'adminMain',
  'adminRace',
  'adminOther',
  'adminHeaders',
  'rateAdmin',
] as const;
const users = [
  'moderator',
  'user',
  'alice',
  'suspended',
  'pending',
  'deletedUser',
  'canceller',
  'eraseUser',
  'rateUser',
] as const;
const accounts = [...admins, ...users] as const;
type Account = (typeof accounts)[number];
const ids = Object.fromEntries(
  accounts.map((account) => [account, randomUUID()]),
) as Record<Account, string>;
const subject = (account: Account) => `data-admin-${run}-${account}`;

// Requests created directly, with known IDs.
const requestKeys = [
  'aliceFirst',
  'deletion',
  'cancelled',
  'suspended',
  'pending',
  'deletedUser',
  'raceCancel',
  'raceOther',
  'cancelAfter',
  'eraseAccess',
  'eraseDeletion',
  'auditFail',
  'rate',
  'headers',
] as const;
type RequestKey = (typeof requestKeys)[number];
const requestIds = Object.fromEntries(
  requestKeys.map((key) => [key, randomUUID()]),
) as Record<RequestKey, string>;
// Created through the user route in case 5.
let aliceSecond = '';

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
      return { subject: subject('adminAuth'), emailVerified: false };
    }
    return { subject: subject(token as Account), emailVerified: false };
  },
};

const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });
// The race cases change the request between the read and the update.
const hooks: DataRequestCompletionHooks = {};
const hookedApp = buildApp({
  logger: false,
  auth: { tokenVerifier },
  storage,
  dataRequests: { completionHooks: hooks },
});

const note = 'Export emailed to the account owner on request.';

function complete(
  token: string | null,
  requestId: string,
  body: object = { note },
  server = app,
) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/admin/data-requests/${requestId}/complete`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

function api(
  method: 'GET' | 'POST',
  url: string,
  token: Account,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });
}

function codeOf(response: { json(): unknown }) {
  return (response.json() as { error: { code: string } }).error.code;
}

interface AdminData {
  id: string;
  userId: string;
  type: string;
  status: string;
  completedAt: string | null;
  completedById: string | null;
  completionActionId: string | null;
  changed: boolean;
}

function dataOf(response: { json(): unknown }): AdminData {
  return (response.json() as { data: AdminData }).data;
}

function completions(requestId: string) {
  return database.moderationAction.findMany({
    where: { dataRequestId: requestId },
  });
}

function stateOf(requestId: string) {
  return database.accountDataRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { status: true, completedAt: true, cancelledAt: true },
  });
}

function completionRow(requestId: string, actor: Account) {
  return {
    actorId: ids[actor],
    action: 'DATA_REQUEST_COMPLETED' as const,
    targetType: 'USER' as const,
    targetId: ids.alice,
    reason: note,
    dataRequestId: requestId,
  };
}

beforeAll(async () => {
  const statusOf = (account: Account) =>
    account === 'suspended'
      ? 'SUSPENDED'
      : account === 'pending' || account === 'eraseUser'
        ? 'PENDING_DELETION'
        : account === 'deletedUser'
          ? 'DELETED'
          : 'ACTIVE';
  for (const account of accounts) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName: `DRA${run}-${account}`,
        status: statusOf(account),
        statusBeforeDeletion:
          account === 'pending' || account === 'eraseUser' ? 'ACTIVE' : null,
        deletedAt: account === 'deletedUser' ? new Date() : null,
        staffRole: (admins as readonly string[]).includes(account)
          ? 'ADMIN'
          : account === 'moderator'
            ? 'MODERATOR'
            : 'USER',
        ...(account !== 'deletedUser' && { profile: { create: {} } }),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(account) },
        },
      },
    });
  }
  const past = new Date(Date.now() - 60_000);
  const fixtures: Array<{
    key: RequestKey;
    user: Account;
    type?: 'ACCESS' | 'ACCOUNT_DELETION';
    status?: 'OPEN' | 'CANCELLED';
  }> = [
    { key: 'aliceFirst', user: 'alice' },
    { key: 'deletion', user: 'pending', type: 'ACCOUNT_DELETION' },
    { key: 'cancelled', user: 'canceller', status: 'CANCELLED' },
    { key: 'suspended', user: 'suspended' },
    { key: 'pending', user: 'pending' },
    { key: 'deletedUser', user: 'deletedUser' },
    { key: 'raceCancel', user: 'user' },
    { key: 'raceOther', user: 'moderator' },
    { key: 'cancelAfter', user: 'canceller' },
    { key: 'eraseAccess', user: 'eraseUser' },
    { key: 'eraseDeletion', user: 'eraseUser', type: 'ACCOUNT_DELETION' },
    { key: 'auditFail', user: 'rateUser' },
    { key: 'rate', user: 'adminMain' },
    { key: 'headers', user: 'adminOther' },
  ];
  for (const { key, user, type = 'ACCESS', status = 'OPEN' } of fixtures) {
    await database.accountDataRequest.create({
      data: {
        id: requestIds[key],
        userId: ids[user],
        type,
        status,
        ...(status === 'CANCELLED' && { cancelledAt: new Date() }),
        // The deletion fixture on "pending" is not due, so the erasure case
        // erases only eraseUser.
        ...(type === 'ACCOUNT_DELETION' && {
          scheduledFor:
            key === 'eraseDeletion'
              ? past
              : new Date(Date.now() + 30 * 86_400_000),
        }),
      },
    });
  }
  await app.ready();
  await hookedApp.ready();
});

afterEach(() => {
  delete hooks.afterRead;
});

afterAll(async () => {
  await app.close();
  await hookedApp.close();
  const userIds = Object.values(ids);
  const allRequestIds = [...Object.values(requestIds), aliceSecond].filter(
    Boolean,
  );
  await database.moderationAction.deleteMany({
    where: {
      OR: [
        { actorId: { in: userIds } },
        { targetId: { in: userIds } },
        { dataRequestId: { in: allRequestIds } },
      ],
    },
  });
  await database.accountCleanupTask.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('completing a data request: callers', () => {
  // The revoked token passes the local check as adminAuth: 1 request.
  it('rejects missing, invalid and revoked tokens', async () => {
    for (const token of [null, 'invalid', 'revoked']) {
      const response = await complete(token, requestIds.aliceFirst);
      expect(response.statusCode).toBe(401);
    }
    expect((await stateOf(requestIds.aliceFirst)).status).toBe('OPEN');
  });

  it('allows only administrators', async () => {
    const user = await complete('user', requestIds.aliceFirst);
    expect(user.statusCode).toBe(403);
    expect(codeOf(user)).toBe('STAFF_ONLY');
    const moderator = await complete('moderator', requestIds.aliceFirst);
    expect(moderator.statusCode).toBe(403);
    expect(codeOf(moderator)).toBe('ADMIN_ONLY');
    expect((await stateOf(requestIds.aliceFirst)).status).toBe('OPEN');
    expect(await completions(requestIds.aliceFirst)).toHaveLength(0);
  });
});

describe('completing a data request: targets', () => {
  // adminAuth: 4 more requests.
  it('returns 404 for an unknown request', async () => {
    const response = await complete('adminAuth', randomUUID());
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('DATA_REQUEST_NOT_FOUND');
  });

  it('leaves deletion requests to the erasure worker', async () => {
    const response = await complete('adminAuth', requestIds.deletion);
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('DATA_REQUEST_AUTOMATIC');
    expect(await stateOf(requestIds.deletion)).toMatchObject({
      status: 'OPEN',
      completedAt: null,
    });
    expect(await completions(requestIds.deletion)).toHaveLength(0);
  });

  it('refuses a cancelled request', async () => {
    const response = await complete('adminAuth', requestIds.cancelled);
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('DATA_REQUEST_NOT_OPEN');
    expect((await stateOf(requestIds.cancelled)).status).toBe('CANCELLED');
  });

  it('rejects a note that is too short once trimmed', async () => {
    const response = await complete('adminAuth', requestIds.aliceFirst, {
      note: '   short       ',
    });
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_ADMIN_NOTE');
    expect((await stateOf(requestIds.aliceFirst)).status).toBe('OPEN');
  });
});

describe('completing a data request: success', () => {
  // adminMain: 6 completions and 2 list requests.
  let firstActionId = '';
  let firstCompletedAt = '';

  it('completes an open ACCESS request and audits it', async () => {
    const response = await complete('adminMain', requestIds.aliceFirst, {
      note: `  ${note}  `,
    });
    expect(response.statusCode).toBe(200);
    const data = dataOf(response);
    expect(data).toMatchObject({
      id: requestIds.aliceFirst,
      userId: ids.alice,
      type: 'ACCESS',
      status: 'COMPLETED',
      completedById: ids.adminMain,
      changed: true,
    });
    expect(data.completedAt).not.toBeNull();
    const rows = await completions(requestIds.aliceFirst);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(
      completionRow(requestIds.aliceFirst, 'adminMain'),
    );
    expect(data.completionActionId).toBe(rows[0]!.id);
    firstActionId = rows[0]!.id;
    firstCompletedAt = data.completedAt!;

    let found = false;
    for (let page = 1; !found && page <= 50; page += 1) {
      const list = await api(
        'GET',
        `/admin/moderation-actions?page=${page}&pageSize=100`,
        'adminMain',
      );
      expect(list.statusCode).toBe(200);
      const body = list.json() as {
        data: Array<{ id: string; action: string; dataRequestId: string }>;
        pagination: { totalPages: number };
      };
      found = body.data.some(
        (row) =>
          row.id === firstActionId &&
          row.action === 'DATA_REQUEST_COMPLETED' &&
          row.dataRequestId === requestIds.aliceFirst,
      );
      if (page >= body.pagination.totalPages) break;
    }
    expect(found).toBe(true);
  });

  it('changes nothing when repeated', async () => {
    const response = await complete('adminMain', requestIds.aliceFirst);
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toMatchObject({
      status: 'COMPLETED',
      completedAt: firstCompletedAt,
      completedById: ids.adminMain,
      completionActionId: firstActionId,
      changed: false,
    });
    expect(await completions(requestIds.aliceFirst)).toHaveLength(1);
  });

  it('lets the user file a new request after completion', async () => {
    const created = await api('POST', '/me/data-requests', 'alice', {
      type: 'ACCESS',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { data: { id: string; status: string } };
    expect(body.data.id).not.toBe(requestIds.aliceFirst);
    expect(body.data.status).toBe('OPEN');
    aliceSecond = body.data.id;

    const repeated = await complete('adminMain', requestIds.aliceFirst);
    expect(dataOf(repeated).changed).toBe(false);
    expect((await stateOf(aliceSecond)).status).toBe('OPEN');
  });

  it('keeps each completion linked to its own request', async () => {
    const response = await complete('adminMain', aliceSecond);
    expect(response.statusCode).toBe(200);
    const second = dataOf(response);
    expect(second.changed).toBe(true);
    const [firstRow] = await completions(requestIds.aliceFirst);
    const [secondRow] = await completions(aliceSecond);
    expect(firstRow!.id).toBe(firstActionId);
    expect(secondRow!.id).not.toBe(firstActionId);
    expect(second.completionActionId).toBe(secondRow!.id);
    expect(secondRow).toMatchObject(completionRow(aliceSecond, 'adminMain'));
  });

  it('shows users the completion but not who made it', async () => {
    const mine = await api('GET', '/me/data-requests', 'alice');
    expect(mine.statusCode).toBe(200);
    const items = (mine.json() as { data: Array<Record<string, unknown>> })
      .data;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.status).toBe('COMPLETED');
      expect(item.completedAt).toEqual(expect.any(String));
      expect(item).not.toHaveProperty('completedById');
      expect(item).not.toHaveProperty('completionActionId');
    }
    expect(mine.body).not.toContain(note);
    expect(mine.body).not.toContain(ids.adminMain);

    const exported = await api('POST', '/me/data-export', 'alice');
    expect(exported.statusCode).toBe(200);
    const requests = (
      exported.json() as {
        account: { dataRequests: Array<Record<string, unknown>> };
      }
    ).account.dataRequests;
    expect(requests).toHaveLength(2);
    for (const item of requests) {
      expect(item.completedAt).toEqual(expect.any(String));
      expect(item).not.toHaveProperty('completedById');
      expect(item).not.toHaveProperty('completionActionId');
    }
    expect(exported.body).not.toContain(note);
  });

  it.each(['suspended', 'pending', 'deletedUser'] as const)(
    'completes a request from a %s account',
    async (key) => {
      const response = await complete('adminMain', requestIds[key]);
      expect(response.statusCode).toBe(200);
      expect(dataOf(response)).toMatchObject({
        status: 'COMPLETED',
        changed: true,
      });
      expect(await completions(requestIds[key])).toHaveLength(1);
    },
  );

  it('lists requests by type and status with their completion', async () => {
    const ours = new Set([...Object.values(requestIds), aliceSecond]);
    const seen: AdminData[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await api(
        'GET',
        `/admin/data-requests?type=ACCESS&status=OPEN&page=${page}&pageSize=100`,
        'adminMain',
      );
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: AdminData[];
        pagination: { totalPages: number };
      };
      for (const item of body.data) {
        expect(item).toMatchObject({ type: 'ACCESS', status: 'OPEN' });
        expect(item).toHaveProperty('completedById', null);
        expect(item).toHaveProperty('completionActionId', null);
        if (ours.has(item.id)) seen.push(item);
      }
      if (page >= body.pagination.totalPages) break;
    }
    expect(seen.map((item) => item.id).sort()).toEqual(
      [
        requestIds.raceCancel,
        requestIds.raceOther,
        requestIds.cancelAfter,
        requestIds.eraseAccess,
        requestIds.auditFail,
        requestIds.rate,
        requestIds.headers,
      ].sort(),
    );

    const completed = await api(
      'GET',
      '/admin/data-requests?type=ACCESS&status=COMPLETED&pageSize=100',
      'adminMain',
    );
    expect(completed.statusCode).toBe(200);
  });
});

describe('completing a data request: races', () => {
  // adminRace: 2 completions; adminOther: 1.
  it('refuses a request cancelled after the read', async () => {
    hooks.afterRead = async () => {
      // Another connection, committed before the transaction's update.
      await database.accountDataRequest.update({
        where: { id: requestIds.raceCancel },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    };
    const response = await complete(
      'adminRace',
      requestIds.raceCancel,
      { note },
      hookedApp,
    );
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('DATA_REQUEST_NOT_OPEN');
    expect((await stateOf(requestIds.raceCancel)).status).toBe('CANCELLED');
    expect(await completions(requestIds.raceCancel)).toHaveLength(0);
  });

  it('returns the other completion when another administrator wins', async () => {
    hooks.afterRead = async () => {
      await database.$transaction([
        database.accountDataRequest.update({
          where: { id: requestIds.raceOther },
          data: { status: 'COMPLETED', completedAt: new Date() },
        }),
        database.moderationAction.create({
          data: {
            ...completionRow(requestIds.raceOther, 'adminOther'),
            targetId: ids.moderator,
          },
        }),
      ]);
    };
    const response = await complete(
      'adminRace',
      requestIds.raceOther,
      { note },
      hookedApp,
    );
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toMatchObject({
      status: 'COMPLETED',
      completedById: ids.adminOther,
      changed: false,
    });
    expect(await completions(requestIds.raceOther)).toHaveLength(1);
  });

  it('keeps the completion when the user cancels afterwards', async () => {
    const completed = await complete('adminOther', requestIds.cancelAfter);
    expect(completed.statusCode).toBe(200);
    const before = await stateOf(requestIds.cancelAfter);
    const cancel = await api(
      'POST',
      `/me/data-requests/${requestIds.cancelAfter}/cancel`,
      'canceller',
    );
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { data: { status: string } }).data.status).toBe(
      'COMPLETED',
    );
    expect(await stateOf(requestIds.cancelAfter)).toEqual(before);
    expect(await completions(requestIds.cancelAfter)).toHaveLength(1);
  });
});

describe('completing a data request: erasure', () => {
  // adminMain: 1 more completion.
  it('can still complete an ACCESS request after the account is erased', async () => {
    await processAccountErasures({
      storage,
      logger: app.log,
      signInAccounts: { async remove() {} },
      now: new Date(),
    });
    expect((await stateOf(requestIds.eraseDeletion)).status).toBe('COMPLETED');
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: ids.eraseUser },
          select: { status: true },
        })
      ).status,
    ).toBe('DELETED');
    expect((await stateOf(requestIds.eraseAccess)).status).toBe('OPEN');

    const response = await complete('adminMain', requestIds.eraseAccess);
    expect(response.statusCode).toBe(200);
    expect(dataOf(response).changed).toBe(true);
    expect((await stateOf(requestIds.eraseAccess)).status).toBe('COMPLETED');
  });

  it('shows worker-completed deletions without an administrator', async () => {
    const response = await api(
      'GET',
      '/admin/data-requests?type=ACCOUNT_DELETION&status=COMPLETED&pageSize=100',
      'adminMain',
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: AdminData[];
      pagination: { totalPages: number };
    };
    let found = body.data.find((item) => item.id === requestIds.eraseDeletion);
    for (
      let page = 2;
      !found && page <= body.pagination.totalPages;
      page += 1
    ) {
      const next = await api(
        'GET',
        `/admin/data-requests?type=ACCOUNT_DELETION&status=COMPLETED&page=${page}&pageSize=100`,
        'adminMain',
      );
      found = (next.json() as { data: AdminData[] }).data.find(
        (item) => item.id === requestIds.eraseDeletion,
      );
    }
    expect(found).toMatchObject({
      completedById: null,
      completionActionId: null,
    });
  });
});

describe('completing a data request: database rules', () => {
  it('keeps the request open when the audit row cannot be written', async () => {
    // No account has this ID, so the audit insert fails its foreign key
    // after the request update has run.
    await expect(
      completeAccessRequest(requestIds.auditFail, randomUUID(), note),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await stateOf(requestIds.auditFail)).toMatchObject({
      status: 'OPEN',
      completedAt: null,
    });
    expect(await completions(requestIds.auditFail)).toHaveLength(0);
  });

  it.each([
    {
      name: 'a request link on another action',
      data: {
        ...completionRow(requestIds.auditFail, 'adminMain'),
        action: 'USER_SUSPENDED' as const,
      },
      error: 'moderation_actions_data_request_link_check',
    },
    {
      name: 'a completion without a request link',
      data: {
        ...completionRow(requestIds.aliceFirst, 'adminMain'),
        dataRequestId: null,
      },
      error: 'moderation_actions_data_request_required_check',
    },
    {
      name: 'a completion on another target type',
      data: {
        ...completionRow(requestIds.auditFail, 'adminMain'),
        targetType: 'TRIP' as const,
      },
      error: 'moderation_actions_data_request_link_check',
    },
  ])('rejects $name', async ({ data, error }) => {
    await expect(database.moderationAction.create({ data })).rejects.toThrow(
      error,
    );
  });

  it('rejects a second completion row for a request', async () => {
    await expect(
      database.moderationAction.create({
        data: completionRow(requestIds.aliceFirst, 'adminMain'),
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await completions(requestIds.aliceFirst)).toHaveLength(1);
  });
});

describe('completing a data request: headers and limits', () => {
  // adminHeaders: 5 requests.
  it('sends no-store on success and on errors', async () => {
    const responses = [
      await complete('adminHeaders', requestIds.headers),
      await complete('adminHeaders', requestIds.headers, {
        note: '          x',
      }),
      await complete('moderator', requestIds.headers),
      await complete('adminHeaders', randomUUID()),
      await complete('adminHeaders', requestIds.deletion),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 400, 403, 404, 409,
    ]);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  // rateAdmin: 21 requests.
  it('allows 20 requests a minute per account', async () => {
    const first = await complete('rateAdmin', requestIds.rate);
    expect(dataOf(first).changed).toBe(true);
    for (let index = 1; index < 20; index += 1) {
      const response = await complete('rateAdmin', requestIds.rate);
      expect(response.statusCode).toBe(200);
      expect(dataOf(response).changed).toBe(false);
    }
    const limited = await complete('rateAdmin', requestIds.rate);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(await completions(requestIds.rate)).toHaveLength(1);
  });
});
