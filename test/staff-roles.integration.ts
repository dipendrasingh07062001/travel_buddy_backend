import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import {
  createStaffRoleRepository,
  prismaStaffRoleRepository,
  type StaffRoleHooks,
} from '../src/modules/staff-roles/staff-role.repository.js';

const run = randomUUID().slice(0, 8);

// Each group of cases has its own administrator, so no group can use up the
// route's limit of 10 requests a minute for another.
const admins = [
  'adminAuth',
  'adminGrant',
  'adminRevoke',
  'adminRace',
  'adminClaims',
  'adminHeaders',
  'rateAdmin',
  'otherAdmin',
] as const;
const moderators = [
  'moderator',
  'mod1',
  'suspendedMod',
  'modWithClaims',
  'otherMod',
  'raceRevoke',
] as const;
const users = [
  'user',
  'reporter1',
  'reporter2',
  'reporter3',
  'reporter4',
  'reported',
  'target',
  'suspended',
  'pending',
  'deleted',
  'raceRole',
  'raceStatus',
  'auditFail',
  'rateTarget',
  'headerTarget',
] as const;
const accounts = [...admins, ...moderators, ...users] as const;
type Account = (typeof accounts)[number];
const ids = Object.fromEntries(
  accounts.map((account) => [account, randomUUID()]),
) as Record<Account, string>;
const subject = (account: Account) => `staff-roles-${run}-${account}`;

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
// The race cases change the account between the read and the update.
const hooks: StaffRoleHooks = {};
const hookedApp = buildApp({
  logger: false,
  auth: { tokenVerifier },
  staffRoles: { repository: createStaffRoleRepository(hooks) },
});

const reason = 'Trusted volunteer for the Goa community.';

function change(
  token: string | null,
  target: string,
  body: object,
  server = app,
) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/admin/users/${target}/staff-role`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

const grant = (token: string, target: Account, server = app) =>
  change(token, ids[target], { role: 'MODERATOR', reason }, server);
const revoke = (token: string, target: Account, server = app) =>
  change(token, ids[target], { role: 'USER', reason }, server);

function staffRequest(token: Account) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/admin/reports',
    headers: { authorization: `Bearer ${token}` },
  });
}

function roleActions(target: Account) {
  return database.moderationAction.findMany({
    where: {
      targetId: ids[target],
      action: { in: ['STAFF_ROLE_GRANTED', 'STAFF_ROLE_REVOKED'] },
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function roleOf(target: Account) {
  const user = await database.user.findUniqueOrThrow({
    where: { id: ids[target] },
    select: { staffRole: true, status: true },
  });
  return user;
}

function codeOf(response: { json(): unknown }) {
  return (response.json() as { error: { code: string } }).error.code;
}

interface Data {
  userId: string;
  staffRole: string;
  changed: boolean;
  claimedReportCount: number;
}

function dataOf(response: { json(): unknown }): Data {
  return (response.json() as { data: Data }).data;
}

const claimedReports: string[] = [];

beforeAll(async () => {
  const statusOf = (account: Account) =>
    account === 'suspended' || account === 'suspendedMod'
      ? 'SUSPENDED'
      : account === 'pending'
        ? 'PENDING_DELETION'
        : account === 'deleted'
          ? 'DELETED'
          : 'ACTIVE';
  for (const account of accounts) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName: `SRM${run}-${account}`,
        status: statusOf(account),
        statusBeforeDeletion: account === 'pending' ? 'ACTIVE' : null,
        deletedAt: account === 'deleted' ? new Date() : null,
        staffRole: (admins as readonly string[]).includes(account)
          ? 'ADMIN'
          : (moderators as readonly string[]).includes(account)
            ? 'MODERATOR'
            : 'USER',
        ...(account !== 'deleted' && { profile: { create: {} } }),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(account) },
        },
      },
    });
  }
  const claims: Array<[Account, number]> = [
    ['modWithClaims', 3],
    ['otherMod', 1],
  ];
  // One open report per reporter and account is allowed, so each fixture
  // report has its own reporter.
  const reporters = [
    'reporter1',
    'reporter2',
    'reporter3',
    'reporter4',
  ] as const;
  let next = 0;
  for (const [reviewer, count] of claims) {
    for (let index = 0; index < count; index += 1) {
      const report = await database.report.create({
        data: {
          reporterId: ids[reporters[next++]!],
          targetType: 'USER',
          reportedUserId: ids.reported,
          reason: 'HARASSMENT',
          status: 'UNDER_REVIEW',
          reviewerId: ids[reviewer],
          reviewedAt: new Date(),
        },
        select: { id: true },
      });
      if (reviewer === 'modWithClaims') claimedReports.push(report.id);
    }
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
  await database.moderationAction.deleteMany({
    where: {
      OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
    },
  });
  await database.report.deleteMany({
    where: { reporterId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('staff role route: callers', () => {
  it('rejects missing, invalid and revoked tokens', async () => {
    for (const token of [null, 'invalid', 'revoked']) {
      const response = await grant(token as string, 'target');
      expect(response.statusCode).toBe(401);
    }
    expect((await roleOf('target')).staffRole).toBe('USER');
  });

  it('allows only administrators', async () => {
    const user = await grant('user', 'target');
    expect(user.statusCode).toBe(403);
    expect(codeOf(user)).toBe('STAFF_ONLY');
    const moderator = await grant('moderator', 'target');
    expect(moderator.statusCode).toBe(403);
    expect(codeOf(moderator)).toBe('ADMIN_ONLY');
    expect(await roleActions('target')).toHaveLength(0);
  });
});

describe('staff role route: targets', () => {
  // adminAuth: 4 requests.
  it('returns 404 for an unknown account', async () => {
    const response = await change('adminAuth', randomUUID(), {
      role: 'MODERATOR',
      reason,
    });
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('USER_NOT_FOUND');
  });

  it('protects the caller and other administrators', async () => {
    const self = await change('adminAuth', ids.adminAuth, {
      role: 'USER',
      reason,
    });
    expect(self.statusCode).toBe(403);
    expect(codeOf(self)).toBe('STAFF_TARGET_PROTECTED');
    const other = await revoke('adminAuth', 'otherAdmin');
    expect(other.statusCode).toBe(403);
    expect(codeOf(other)).toBe('STAFF_TARGET_PROTECTED');
    expect((await roleOf('otherAdmin')).staffRole).toBe('ADMIN');
    expect(await roleActions('otherAdmin')).toHaveLength(0);
    expect(await roleActions('adminAuth')).toHaveLength(0);
  });

  it('rejects a reason that is too short once trimmed', async () => {
    const response = await change('adminAuth', ids.target, {
      role: 'MODERATOR',
      reason: '   short       ',
    });
    expect(response.statusCode).toBe(400);
    expect(codeOf(response)).toBe('INVALID_MODERATION_REASON');
    expect((await roleOf('target')).staffRole).toBe('USER');
  });
});

describe('staff role route: granting', () => {
  // adminGrant: 5 requests.
  it('makes an active user a moderator and ignores unknown fields', async () => {
    const response = await change('adminGrant', ids.target, {
      role: 'MODERATOR',
      reason: `  ${reason}  `,
      notify: true,
    });
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toEqual({
      userId: ids.target,
      staffRole: 'MODERATOR',
      changed: true,
      claimedReportCount: 0,
    });
    expect((await roleOf('target')).staffRole).toBe('MODERATOR');
    expect((await staffRequest('target')).statusCode).toBe(200);
    const actions = await roleActions('target');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'STAFF_ROLE_GRANTED',
      actorId: ids.adminGrant,
      targetType: 'USER',
      targetId: ids.target,
      reason,
    });
  });

  it.each(['suspended', 'pending', 'deleted'] as const)(
    'refuses to grant the role to a %s account',
    async (account) => {
      const response = await grant('adminGrant', account);
      expect(response.statusCode).toBe(409);
      expect(codeOf(response)).toBe('USER_NOT_ACTIVE');
      expect((await roleOf(account)).staffRole).toBe('USER');
      expect(await roleActions(account)).toHaveLength(0);
    },
  );

  it('changes nothing when the account already has the role', async () => {
    const response = await grant('adminGrant', 'target');
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toMatchObject({
      staffRole: 'MODERATOR',
      changed: false,
    });
    expect(await roleActions('target')).toHaveLength(1);
  });
});

describe('staff role route: revoking', () => {
  // adminRevoke: 3 requests.
  it('removes the role, effective on the next request', async () => {
    expect((await staffRequest('mod1')).statusCode).toBe(200);
    const response = await revoke('adminRevoke', 'mod1');
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toEqual({
      userId: ids.mod1,
      staffRole: 'USER',
      changed: true,
      claimedReportCount: 0,
    });
    const next = await staffRequest('mod1');
    expect(next.statusCode).toBe(403);
    expect(codeOf(next)).toBe('STAFF_ONLY');
    const actions = await roleActions('mod1');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'STAFF_ROLE_REVOKED',
      actorId: ids.adminRevoke,
      reason,
    });
  });

  it('removes the role from a suspended moderator', async () => {
    const response = await revoke('adminRevoke', 'suspendedMod');
    expect(response.statusCode).toBe(200);
    expect(dataOf(response).staffRole).toBe('USER');
    expect(await roleOf('suspendedMod')).toEqual({
      staffRole: 'USER',
      status: 'SUSPENDED',
    });
    // The account check runs before the staff check.
    const next = await staffRequest('suspendedMod');
    expect(next.statusCode).toBe(403);
    expect(codeOf(next)).toBe('ACCOUNT_SUSPENDED');
  });

  it('changes nothing when the role is already gone', async () => {
    const response = await revoke('adminRevoke', 'mod1');
    expect(response.statusCode).toBe(200);
    expect(dataOf(response)).toMatchObject({
      staffRole: 'USER',
      changed: false,
    });
    expect(await roleActions('mod1')).toHaveLength(1);
  });

  it('shows each change in the audit trail', async () => {
    const [action] = await roleActions('mod1');
    let found = false;
    for (let page = 1; !found && page <= 50; page += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/moderation-actions?page=${page}&pageSize=100`,
        headers: { authorization: 'Bearer adminRevoke' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: string; action: string; actorId: string }>;
        pagination: { totalPages: number };
      };
      found = body.data.some(
        (row) =>
          row.id === action!.id &&
          row.action === 'STAFF_ROLE_REVOKED' &&
          row.actorId === ids.adminRevoke,
      );
      if (page >= body.pagination.totalPages) break;
    }
    expect(found).toBe(true);
  });
});

describe('staff role repository: failures', () => {
  it('keeps the role when the audit row cannot be written', async () => {
    // No account has this ID, so the audit insert fails its foreign key
    // after the role update has run.
    await expect(
      prismaStaffRoleRepository.change({
        actorId: randomUUID(),
        targetId: ids.auditFail,
        role: 'MODERATOR',
        reason,
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect((await roleOf('auditFail')).staffRole).toBe('USER');
    expect(await roleActions('auditFail')).toHaveLength(0);
  });

  // adminRace: 3 requests.
  it.each([
    {
      name: 'a grant after the role changed',
      target: 'raceRole' as const,
      role: 'MODERATOR',
      write: { staffRole: 'MODERATOR' as const },
    },
    {
      name: 'a grant after the account was suspended',
      target: 'raceStatus' as const,
      role: 'MODERATOR',
      write: { status: 'SUSPENDED' as const },
    },
    {
      name: 'a revoke after the role changed',
      target: 'raceRevoke' as const,
      role: 'USER',
      write: { staffRole: 'USER' as const },
    },
  ])('rejects $name', async ({ target, role, write }) => {
    hooks.afterRead = async () => {
      // Another connection, committed before the transaction's update.
      await database.user.update({ where: { id: ids[target] }, data: write });
    };
    const response = await change(
      'adminRace',
      ids[target],
      { role, reason },
      hookedApp,
    );
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('USER_STATE_CHANGED');
    expect(await roleOf(target)).toMatchObject(write);
    expect(await roleActions(target)).toHaveLength(0);
  });
});

describe('staff role route: claimed reports', () => {
  // adminClaims: 5 role requests and 1 resolve.
  async function reviewStates() {
    return database.report.findMany({
      where: { id: { in: claimedReports } },
      select: { status: true, reviewerId: true, reviewedAt: true },
    });
  }

  it('leaves claimed reports with the former moderator and counts them', async () => {
    const before = await reviewStates();
    const revoked = await revoke('adminClaims', 'modWithClaims');
    expect(revoked.statusCode).toBe(200);
    expect(dataOf(revoked)).toMatchObject({
      changed: true,
      claimedReportCount: 3,
    });
    expect(await reviewStates()).toEqual(before);
    expect(before.every((report) => report.status === 'UNDER_REVIEW')).toBe(
      true,
    );

    const repeated = await revoke('adminClaims', 'modWithClaims');
    expect(dataOf(repeated)).toMatchObject({
      changed: false,
      claimedReportCount: 3,
    });
    expect(await roleActions('modWithClaims')).toHaveLength(1);
  });

  it('counts remaining claims on a grant too', async () => {
    const granted = await grant('adminClaims', 'modWithClaims');
    expect(dataOf(granted)).toMatchObject({
      changed: true,
      claimedReportCount: 3,
    });
    const revoked = await revoke('adminClaims', 'modWithClaims');
    expect(dataOf(revoked)).toMatchObject({
      changed: true,
      claimedReportCount: 3,
    });
  });

  it('lets an administrator resolve a former moderator’s claim', async () => {
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reports/${claimedReports[0]}/resolve`,
      headers: { authorization: 'Bearer adminClaims' },
      payload: { resolution: 'DISMISS', reason },
    });
    expect(resolved.statusCode).toBe(200);
    const repeated = await revoke('adminClaims', 'modWithClaims');
    expect(dataOf(repeated)).toMatchObject({
      changed: false,
      claimedReportCount: 2,
    });
  });
});

describe('staff role route: headers and limits', () => {
  // adminHeaders: 4 requests.
  it('sends no-store on success and on errors', async () => {
    const responses = [
      await grant('adminHeaders', 'headerTarget'),
      await change('adminHeaders', ids.headerTarget, {
        role: 'USER',
        reason: '          x',
      }),
      await change('adminHeaders', ids.adminHeaders, { role: 'USER', reason }),
      await grant('adminHeaders', 'suspended'),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 400, 403, 409,
    ]);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  // rateAdmin: 11 requests.
  it('allows 10 requests a minute per account', async () => {
    for (let index = 0; index < 10; index += 1) {
      const response = await revoke('rateAdmin', 'rateTarget');
      expect(response.statusCode).toBe(200);
      expect(dataOf(response).changed).toBe(false);
    }
    const limited = await revoke('rateAdmin', 'rateTarget');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(await roleActions('rateTarget')).toHaveLength(0);
  });
});
