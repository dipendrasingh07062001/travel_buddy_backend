import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import { prismaAdminUserRepository } from '../src/modules/admin-users/admin-users.repository.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const run = randomUUID().slice(0, 8);
const day = 86_400_000;

const admins = ['admin', 'adminRate', 'otherAdmin'] as const;
const moderators = ['moderator', 'suspendedMod', 'pendingMod'] as const;
const users = [
  'user',
  'subject',
  'privateOnly',
  'contentOwner',
  'bothVerified',
  'phoneOnly',
  'noIdentity',
  'formerMod',
  'suspendedUser',
  'pendingUser',
  'erased',
  'peer',
  'blocker1',
  'blocker2',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
] as const;
const accounts = [...admins, ...moderators, ...users] as const;
type Account = (typeof accounts)[number];
const ids = Object.fromEntries(
  accounts.map((account) => [account, randomUUID()]),
) as Record<Account, string>;
const subject = (account: Account) => `account-detail-${run}-${account}`;

// Stored contact values; none may ever appear in a response.
const phone = () => `+9198${String(randomInt(10_000_000, 99_999_999))}`;
const contacts = {
  subjectEmail: `subject-${run}@example.test`,
  subjectPhone: phone(),
  bothEmail: `both-${run}@example.test`,
  bothPhone: phone(),
  phoneOnlyEmail: `phone-only-${run}@example.test`,
  phoneOnlyPhone: phone(),
  erasedEmail: `erased-${run}@example.test`,
};

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

const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });

// A second app whose repository fails, with logs captured.
const secret = `leak-${run}@example.test`;
const logText: string[] = [];
const stream = new Writable({
  write(chunk, _encoding, callback) {
    logText.push(String(chunk));
    callback();
  },
});
const failingApp = buildApp({
  logger: { level: 'info', stream },
  auth: { tokenVerifier },
  adminUsers: {
    repository: {
      ...prismaAdminUserRepository,
      async detail() {
        throw new Error(`Invalid query: normalizedValue "${secret}"`);
      },
    },
  },
});

function get(token: string | null, url: string, server = app) {
  return server.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const detailOf = (token: string | null, target: string, server = app) =>
  get(token, `/admin/users/${target}`, server);

function codeOf(response: { json(): unknown }) {
  return (response.json() as { error: { code: string } }).error.code;
}

interface Counts {
  submitted: number;
  underReview: number;
  actioned: number;
  dismissed: number;
}

interface Detail {
  account: Record<string, unknown> & {
    status: string;
    staffRole: string;
    deletedAt: string | null;
    recordsPurgedAt: string | null;
    hasVerifiedEmail: boolean;
    hasVerifiedPhone: boolean;
  };
  activeRestrictions: Array<Record<string, unknown>>;
  reports: { aboutAccount: Counts; filed: Counts };
  claimedReportCount: number;
  content: Record<string, unknown>;
  openDataRequests: Array<Record<string, unknown>> | null;
}

function dataOf(response: { json(): unknown }): Detail {
  return (response.json() as { data: Detail }).data;
}

const zero = { submitted: 0, underReview: 0, actioned: 0, dismissed: 0 };

const communityId = randomUUID();
const tripIds = {
  subjectDraft: randomUUID(),
  subjectPublished: randomUUID(),
  subjectCancelled: randomUUID(),
  peer: randomUUID(),
  contentOwner: randomUUID(),
  erased: randomUUID(),
};
const postIds = {
  draft: randomUUID(),
  published: randomUUID(),
  removed: randomUUID(),
  ownerRemoved: randomUUID(),
  erased: randomUUID(),
};
const commentIds = {
  active: randomUUID(),
  edited: randomUUID(),
  removed: randomUUID(),
  owner: randomUUID(),
  erased: randomUUID(),
};
const conversationIds = { peer: randomUUID(), owner: randomUUID() };
const messageIds = { privateOnly: randomUUID(), owner: randomUUID() };
const connectionRequestId = randomUUID();
const restrictionIds = {
  open: randomUUID(),
  timed: randomUUID(),
  lifted: randomUUID(),
  expired: randomUUID(),
  future: randomUUID(),
};
const dataRequestIds = { open: randomUUID(), cancelled: randomUUID() };
// subject's USER and PROFILE_PHOTO reports, oldest first.
const subjectReportIds: string[] = [];
const erasedReportIds: string[] = [];
let erasedCommentReportId = '';
const auditIds: string[] = [];
const contentIds = [
  ...Object.values(tripIds),
  ...Object.values(postIds),
  ...Object.values(commentIds),
  ...Object.values(messageIds),
  connectionRequestId,
];

beforeAll(async () => {
  const statusOf = (account: Account) =>
    account === 'suspendedMod' || account === 'suspendedUser'
      ? 'SUSPENDED'
      : account === 'pendingMod' ||
          account === 'pendingUser' ||
          account === 'erased'
        ? 'PENDING_DELETION'
        : 'ACTIVE';
  for (const account of accounts) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName: `AAD${run}-${account}`,
        status: statusOf(account),
        statusBeforeDeletion:
          account === 'pendingUser'
            ? 'SUSPENDED'
            : statusOf(account) === 'PENDING_DELETION'
              ? 'ACTIVE'
              : null,
        staffRole: (admins as readonly string[]).includes(account)
          ? 'ADMIN'
          : (moderators as readonly string[]).includes(account)
            ? 'MODERATOR'
            : 'USER',
        profile: {
          create:
            account === 'subject' || account === 'erased'
              ? { profilePhotoStorageKey: `profile-photos/${run}-${account}` }
              : {},
        },
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject(account) },
        },
      },
    });
  }

  const verified = new Date();
  await database.authIdentity.createMany({
    data: [
      {
        userId: ids.subject,
        type: 'EMAIL',
        normalizedValue: contacts.subjectEmail,
        verifiedAt: verified,
      },
      {
        userId: ids.subject,
        type: 'PHONE',
        normalizedValue: contacts.subjectPhone,
      },
      {
        userId: ids.bothVerified,
        type: 'EMAIL',
        normalizedValue: contacts.bothEmail,
        verifiedAt: verified,
      },
      {
        userId: ids.bothVerified,
        type: 'PHONE',
        normalizedValue: contacts.bothPhone,
        verifiedAt: verified,
      },
      {
        userId: ids.phoneOnly,
        type: 'EMAIL',
        normalizedValue: contacts.phoneOnlyEmail,
      },
      {
        userId: ids.phoneOnly,
        type: 'PHONE',
        normalizedValue: contacts.phoneOnlyPhone,
        verifiedAt: verified,
      },
      {
        userId: ids.erased,
        type: 'EMAIL',
        normalizedValue: contacts.erasedEmail,
        verifiedAt: verified,
      },
    ],
  });

  const now = Date.now();
  const restriction = {
    userId: ids.subject,
    reason: 'Repeated unwanted contact after warnings.',
    createdById: ids.admin,
  };
  await database.accountRestriction.createMany({
    data: [
      {
        ...restriction,
        id: restrictionIds.open,
        feature: 'CONNECTION_REQUESTS',
        startsAt: new Date(now - 2 * day),
      },
      {
        ...restriction,
        id: restrictionIds.timed,
        feature: 'MESSAGING',
        startsAt: new Date(now - day),
        endsAt: new Date(now + 10 * day),
      },
      {
        ...restriction,
        id: restrictionIds.lifted,
        feature: 'COMMUNITY_POSTING',
        startsAt: new Date(now - 3 * day),
        liftedAt: new Date(now - day),
        liftedById: ids.admin,
        liftReason: 'Lifted after the appeal was reviewed.',
      },
      {
        ...restriction,
        id: restrictionIds.expired,
        feature: 'TRIP_PUBLISHING',
        startsAt: new Date(now - 20 * day),
        endsAt: new Date(now - 10 * day),
      },
      {
        ...restriction,
        id: restrictionIds.future,
        feature: 'TRIP_PUBLISHING',
        startsAt: new Date(now + day),
        endsAt: new Date(now + 5 * day),
      },
    ],
  });

  await database.community.create({
    data: {
      id: communityId,
      slug: `account-detail-${communityId}`,
      name: 'Account Detail Community',
    },
  });
  const startDate = new Date(now + 30 * day);
  const endDate = new Date(now + 33 * day);
  const trip = (id: string, owner: Account, status: string) =>
    database.trip.create({
      data: {
        id,
        ownerId: ids[owner],
        destinationName: 'Goa',
        originCity: 'Delhi',
        startDate,
        endDate,
        durationDays: 4,
        desiredGroupSize: 3,
        status: status as 'DRAFT' | 'PUBLISHED' | 'CANCELLED',
        ...(status === 'PUBLISHED' && { publishedAt: new Date() }),
      },
    });
  await trip(tripIds.subjectDraft, 'subject', 'DRAFT');
  await trip(tripIds.subjectPublished, 'subject', 'PUBLISHED');
  await trip(tripIds.subjectCancelled, 'subject', 'CANCELLED');
  await trip(tripIds.peer, 'peer', 'DRAFT');
  await trip(tripIds.contentOwner, 'contentOwner', 'DRAFT');
  await trip(tripIds.erased, 'erased', 'DRAFT');

  const post = (
    id: string,
    author: Account,
    status: 'DRAFT' | 'PUBLISHED' | 'REMOVED',
  ) =>
    database.communityPost.create({
      data: {
        id,
        communityId,
        authorId: ids[author],
        type: 'DISCUSSION',
        status,
        title: 'Account detail test post',
        body: 'A post created to test account detail counts.',
        ...(status !== 'DRAFT' && { publishedAt: new Date() }),
        ...(status === 'REMOVED' && { removedAt: new Date() }),
      },
    });
  await post(postIds.draft, 'subject', 'DRAFT');
  await post(postIds.published, 'subject', 'PUBLISHED');
  await post(postIds.removed, 'subject', 'REMOVED');
  await post(postIds.ownerRemoved, 'contentOwner', 'REMOVED');
  await post(postIds.erased, 'erased', 'PUBLISHED');

  const comment = (
    id: string,
    author: Account,
    status: 'ACTIVE' | 'EDITED' | 'REMOVED',
    postId = postIds.published,
  ) =>
    database.communityComment.create({
      data: {
        id,
        postId,
        authorId: ids[author],
        status,
        body: 'A comment created to test account detail counts.',
        ...(status === 'EDITED' && { editedAt: new Date() }),
        ...(status === 'REMOVED' && { removedAt: new Date() }),
      },
    });
  await comment(commentIds.active, 'subject', 'ACTIVE');
  await comment(commentIds.edited, 'subject', 'EDITED');
  await comment(commentIds.removed, 'subject', 'REMOVED');
  await comment(commentIds.owner, 'contentOwner', 'ACTIVE');
  await comment(commentIds.erased, 'erased', 'ACTIVE', postIds.erased);

  // Private content: one message each, in two trip rooms.
  await database.conversation.create({
    data: {
      id: conversationIds.peer,
      tripId: tripIds.peer,
      participants: {
        create: [{ userId: ids.peer }, { userId: ids.privateOnly }],
      },
      messages: {
        create: {
          id: messageIds.privateOnly,
          senderId: ids.privateOnly,
          body: 'A private message used to test account detail.',
        },
      },
    },
  });
  await database.conversation.create({
    data: {
      id: conversationIds.owner,
      tripId: tripIds.contentOwner,
      participants: {
        create: [{ userId: ids.contentOwner }, { userId: ids.peer }],
      },
      messages: {
        create: {
          id: messageIds.owner,
          senderId: ids.contentOwner,
          body: 'Another private message used to test account detail.',
        },
      },
    },
  });
  await database.connectionRequest.create({
    data: {
      id: connectionRequestId,
      tripId: tripIds.peer,
      requesterId: ids.contentOwner,
      recipientId: ids.peer,
      message: 'Hello, may I join this trip?',
    },
  });

  await database.userBlock.createMany({
    data: [
      { blockerId: ids.blocker1, blockedId: ids.subject },
      { blockerId: ids.blocker2, blockedId: ids.subject },
      { blockerId: ids.blocker1, blockedId: ids.erased },
    ],
  });

  // Reports. Open reports are unique per reporter and target, so each has
  // its own reporter where they could clash. Times fix the list order.
  let minute = 0;
  const report = async (
    reporter: Account,
    status: 'SUBMITTED' | 'UNDER_REVIEW' | 'ACTIONED' | 'DISMISSED',
    target: Record<string, unknown>,
    reviewer: Account = 'moderator',
  ) => {
    minute += 1;
    const row = await database.report.create({
      data: {
        reporterId: ids[reporter],
        reason: 'HARASSMENT',
        status,
        createdAt: new Date(now - 100 * 60_000 + minute * 60_000),
        ...(status !== 'SUBMITTED' && {
          reviewerId: ids[reviewer],
          reviewedAt: new Date(),
        }),
        ...((status === 'ACTIONED' || status === 'DISMISSED') && {
          resolvedAt: new Date(),
        }),
        ...(target as { targetType: 'USER' }),
      },
      select: { id: true },
    });
    return row.id;
  };
  const aboutUser = (account: Account) => ({
    targetType: 'USER',
    reportedUserId: ids[account],
  });
  const aboutPhoto = (account: Account) => ({
    targetType: 'PROFILE_PHOTO',
    reportedUserId: ids[account],
    reportedPhotoKey: `profile-photos/${run}-${account}`,
  });
  subjectReportIds.push(
    await report('r1', 'SUBMITTED', aboutUser('subject')),
    await report('r2', 'UNDER_REVIEW', aboutUser('subject')),
    await report('r3', 'ACTIONED', aboutUser('subject')),
    await report('r4', 'DISMISSED', aboutUser('subject')),
    await report('r5', 'SUBMITTED', aboutPhoto('subject')),
    await report('r6', 'DISMISSED', aboutPhoto('subject')),
  );
  await report('subject', 'SUBMITTED', aboutUser('r7'));
  await report('subject', 'UNDER_REVIEW', aboutUser('r8'));
  await report('subject', 'ACTIONED', aboutUser('r9'));
  await report('subject', 'DISMISSED', aboutUser('r10'));
  // The private-only account's single report is on its message (S3-1).
  await report('r11', 'SUBMITTED', {
    targetType: 'MESSAGE',
    reportedMessageId: messageIds.privateOnly,
  });
  for (const target of [
    { targetType: 'TRIP', reportedTripId: tripIds.contentOwner },
    {
      targetType: 'COMMUNITY_POST',
      reportedCommunityPostId: postIds.ownerRemoved,
    },
    {
      targetType: 'COMMUNITY_COMMENT',
      reportedCommunityCommentId: commentIds.owner,
    },
    { targetType: 'MESSAGE', reportedMessageId: messageIds.owner },
    {
      targetType: 'CONNECTION_REQUEST',
      reportedConnectionRequestId: connectionRequestId,
    },
  ]) {
    await report('r12', 'SUBMITTED', target);
  }
  await report('r11', 'UNDER_REVIEW', aboutUser('peer'), 'formerMod');
  await report('r12', 'UNDER_REVIEW', aboutUser('peer'), 'formerMod');
  erasedReportIds.push(
    await report('r1', 'SUBMITTED', aboutUser('erased')),
    await report('r2', 'SUBMITTED', aboutPhoto('erased')),
  );
  erasedCommentReportId = await report('r3', 'SUBMITTED', {
    targetType: 'COMMUNITY_COMMENT',
    reportedCommunityCommentId: commentIds.erased,
  });

  await database.accountDataRequest.createMany({
    data: [
      { id: dataRequestIds.open, userId: ids.subject, type: 'ACCESS' },
      {
        id: dataRequestIds.cancelled,
        userId: ids.subject,
        type: 'ACCESS',
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
      {
        userId: ids.erased,
        type: 'ACCOUNT_DELETION',
        scheduledFor: new Date(now - 60_000),
      },
    ],
  });

  // Audit rows with fixed times: three on subject, one TRIP row that reuses
  // subject's ID, and one on another account.
  const action = async (
    targetType: 'USER' | 'TRIP',
    targetId: string,
    offset: number,
  ) => {
    const row = await database.moderationAction.create({
      data: {
        actorId: ids.admin,
        action: targetType === 'USER' ? 'USER_SUSPENDED' : 'CONTENT_REMOVED',
        targetType,
        targetId,
        reason: 'Audit filter fixture for account detail.',
        createdAt: new Date(now - 50 * 60_000 + offset * 60_000),
      },
      select: { id: true },
    });
    return row.id;
  };
  auditIds.push(
    await action('USER', ids.subject, 1),
    await action('USER', ids.subject, 2),
    await action('USER', ids.subject, 3),
    await action('TRIP', ids.subject, 4),
    await action('USER', ids.peer, 5),
  );

  await app.ready();
  await failingApp.ready();
});

afterAll(async () => {
  await app.close();
  await failingApp.close();
  const userIds = Object.values(ids);
  await database.moderationAction.deleteMany({
    where: {
      OR: [
        { actorId: { in: userIds } },
        { targetId: { in: [...userIds, ...contentIds] } },
      ],
    },
  });
  await database.report.deleteMany({
    where: {
      OR: [
        { reporterId: { in: userIds } },
        { reportedUserId: { in: userIds } },
      ],
    },
  });
  await database.accountRestriction.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.userBlock.deleteMany({
    where: {
      OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }],
    },
  });
  await database.communityComment.deleteMany({
    where: { postId: { in: Object.values(postIds) } },
  });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.message.deleteMany({
    where: { conversationId: { in: Object.values(conversationIds) } },
  });
  await database.conversation.deleteMany({
    where: { id: { in: Object.values(conversationIds) } },
  });
  await database.connectionRequest.deleteMany({
    where: { id: connectionRequestId },
  });
  await database.tripChange.deleteMany({
    where: { tripId: { in: Object.values(tripIds) } },
  });
  await database.trip.deleteMany({
    where: { id: { in: Object.values(tripIds) } },
  });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.accountCleanupTask.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.authIdentity.deleteMany({
    where: { userId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('account detail: callers', () => {
  it('rejects missing, invalid and revoked tokens', async () => {
    for (const token of [null, 'invalid', 'revoked']) {
      const response = await detailOf(token, ids.subject);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('allows only active staff', async () => {
    const user = await detailOf('user', ids.subject);
    expect(user.statusCode).toBe(403);
    expect(codeOf(user)).toBe('STAFF_ONLY');
    const suspended = await detailOf('suspendedMod', ids.subject);
    expect(suspended.statusCode).toBe(403);
    expect(codeOf(suspended)).toBe('ACCOUNT_SUSPENDED');
    const pending = await detailOf('pendingMod', ids.subject);
    expect(pending.statusCode).toBe(403);
    expect(codeOf(pending)).toBe('ACCOUNT_DELETION_PENDING');
    expect((await detailOf('moderator', ids.subject)).statusCode).toBe(200);
    expect((await detailOf('admin', ids.subject)).statusCode).toBe(200);
  });
});

describe('account detail: targets', () => {
  it('returns 404 for an unknown account', async () => {
    const response = await detailOf('admin', randomUUID());
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('USER_NOT_FOUND');
  });

  it.each([
    ['the caller', 'admin', 'ADMIN'],
    ['a moderator', 'moderator', 'MODERATOR'],
    ['another administrator', 'otherAdmin', 'ADMIN'],
    ['a former moderator', 'formerMod', 'USER'],
  ] as const)('shows %s', async (_name, target, role) => {
    const response = await detailOf('admin', ids[target]);
    expect(response.statusCode).toBe(200);
    expect(dataOf(response).account.staffRole).toBe(role);
  });
});

describe('account detail: contents', () => {
  it('shows the full detail to an administrator', async () => {
    const response = await detailOf('admin', ids.subject);
    expect(response.statusCode).toBe(200);
    const data = dataOf(response);
    const user = await database.user.findUniqueOrThrow({
      where: { id: ids.subject },
      select: { createdAt: true },
    });
    const restrictions = await database.accountRestriction.findMany({
      where: { id: { in: [restrictionIds.open, restrictionIds.timed] } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const open = await database.accountDataRequest.findUniqueOrThrow({
      where: { id: dataRequestIds.open },
    });
    expect(data).toEqual({
      account: {
        id: ids.subject,
        displayName: `AAD${run}-subject`,
        status: 'ACTIVE',
        staffRole: 'USER',
        createdAt: user.createdAt.toISOString(),
        deletedAt: null,
        recordsPurgedAt: null,
        statusBeforeDeletion: null,
        hasProfilePhoto: true,
        hasVerifiedEmail: true,
        hasVerifiedPhone: false,
      },
      activeRestrictions: restrictions.map((row) => ({
        id: row.id,
        feature: row.feature,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
      })),
      reports: {
        aboutAccount: {
          submitted: 2,
          underReview: 1,
          actioned: 1,
          dismissed: 2,
        },
        filed: { submitted: 1, underReview: 1, actioned: 1, dismissed: 1 },
      },
      claimedReportCount: 0,
      content: {
        trips: 3,
        communityPosts: { draft: 1, published: 1, removed: 1 },
        communityComments: { visible: 2, removed: 1 },
        blockedByCount: 2,
      },
      openDataRequests: [
        {
          id: open.id,
          type: 'ACCESS',
          createdAt: open.createdAt.toISOString(),
          scheduledFor: null,
        },
      ],
    });
    expect(response.body).not.toContain('reason');
    for (const value of [
      contacts.subjectEmail,
      contacts.subjectPhone,
      ids.blocker1,
      ids.blocker2,
      ids.r1,
      ids.r7,
    ]) {
      expect(response.body).not.toContain(value);
    }
  });

  it('hides data requests from moderators', async () => {
    const response = await detailOf('moderator', ids.subject);
    const data = dataOf(response);
    expect(data.openDataRequests).toBeNull();
    expect(data.reports.aboutAccount.submitted).toBe(2);
  });

  it('matches the search summary’s open report count', async () => {
    const search = await get('moderator', `/admin/users?query=${ids.subject}`);
    const [row] = (
      search.json() as { data: Array<{ openReportCount: number }> }
    ).data;
    const { aboutAccount } = dataOf(
      await detailOf('moderator', ids.subject),
    ).reports;
    expect(row!.openReportCount).toBe(
      aboutAccount.submitted + aboutAccount.underReview,
    );
  });

  it('never links reports on content to the account (D5)', async () => {
    for (const target of ['privateOnly', 'contentOwner'] as const) {
      const response = await detailOf('admin', ids[target]);
      const data = dataOf(response);
      expect(data.reports).toEqual({ aboutAccount: zero, filed: zero });
      expect(Object.keys(data.reports)).toEqual(['aboutAccount', 'filed']);
    }
  });

  it.each([
    ['bothVerified', true, true],
    ['phoneOnly', false, true],
    ['noIdentity', false, false],
  ] as const)('reads verification for %s', async (target, email, phoneFlag) => {
    const response = await detailOf('admin', ids[target]);
    expect(dataOf(response).account).toMatchObject({
      hasVerifiedEmail: email,
      hasVerifiedPhone: phoneFlag,
    });
    for (const value of Object.values(contacts)) {
      expect(response.body).not.toContain(value);
    }
  });

  it('counts reports a former moderator still has under review', async () => {
    const data = dataOf(await detailOf('admin', ids.formerMod));
    expect(data.account.staffRole).toBe('USER');
    expect(data.claimedReportCount).toBe(2);
  });

  it('shows suspended and pending-deletion accounts', async () => {
    const suspended = dataOf(await detailOf('admin', ids.suspendedUser));
    expect(suspended.account).toMatchObject({
      status: 'SUSPENDED',
      statusBeforeDeletion: null,
    });
    expect(suspended.openDataRequests).toEqual([]);
    const pending = dataOf(await detailOf('admin', ids.pendingUser));
    expect(pending.account).toMatchObject({
      status: 'PENDING_DELETION',
      statusBeforeDeletion: 'SUSPENDED',
    });
  });
});

describe('account detail: erasure and purge', () => {
  const erasure = (now: Date) =>
    processAccountErasures({
      storage,
      logger: app.log,
      signInAccounts: { async remove() {} },
      now,
    });

  it('keeps retained rows counted after erasure and after the purge', async () => {
    const before = dataOf(await detailOf('admin', ids.erased));
    expect(before.account.hasVerifiedEmail).toBe(true);
    expect(before.content).toMatchObject({ blockedByCount: 1 });

    await erasure(new Date());
    const stored = await database.user.findUniqueOrThrow({
      where: { id: ids.erased },
      select: { status: true, deletedAt: true },
    });
    expect(stored.status).toBe('DELETED');

    const erased = dataOf(await detailOf('admin', ids.erased));
    expect(erased.account).toMatchObject({
      status: 'DELETED',
      deletedAt: stored.deletedAt!.toISOString(),
      recordsPurgedAt: null,
      hasProfilePhoto: false,
      hasVerifiedEmail: false,
      hasVerifiedPhone: false,
    });
    expect(erased.content).toEqual({
      trips: 1,
      communityPosts: { draft: 0, published: 0, removed: 1 },
      communityComments: { visible: 0, removed: 1 },
      blockedByCount: 0,
    });
    expect(erased.reports.aboutAccount).toEqual({ ...zero, submitted: 2 });

    await erasure(new Date(stored.deletedAt!.getTime() + 366 * day));
    const purged = dataOf(await detailOf('admin', ids.erased));
    expect(purged.account.recordsPurgedAt).not.toBeNull();
    expect(purged.content).toEqual(erased.content);
    expect(purged.reports).toEqual(erased.reports);
    expect(purged.claimedReportCount).toBe(erased.claimedReportCount);
  });
});

describe('reports filter by account', () => {
  async function reports(query: string) {
    const response = await get('moderator', `/admin/reports?${query}`);
    expect(response.statusCode).toBe(200);
    return response.json() as {
      data: Array<{ id: string; status: string }>;
      pagination: { totalItems: number; totalPages: number };
    };
  }

  function inspections() {
    return database.moderationAction.count({
      where: { actorId: ids.moderator, action: 'REPORT_INSPECTED' },
    });
  }

  it('lists only reports that name the account, oldest first', async () => {
    const before = await inspections();
    const all = await reports(`userId=${ids.subject}&pageSize=100`);
    expect(all.data.map((row) => row.id)).toEqual(subjectReportIds);
    expect(all.pagination.totalItems).toBe(subjectReportIds.length);

    for (let page = 1; page <= subjectReportIds.length + 1; page += 1) {
      const one = await reports(
        `userId=${ids.subject}&page=${page}&pageSize=1`,
      );
      expect(one.pagination.totalItems).toBe(subjectReportIds.length);
      expect(one.data.map((row) => row.id)).toEqual(
        subjectReportIds.slice(page - 1, page),
      );
    }

    const submitted = await reports(`userId=${ids.subject}&status=SUBMITTED`);
    expect(submitted.data.map((row) => row.id)).toEqual([
      subjectReportIds[0],
      subjectReportIds[4],
    ]);
    expect(await inspections()).toBe(before);
  });

  it('leaves out every report on content', async () => {
    for (const target of ['contentOwner', 'privateOnly'] as const) {
      const result = await reports(`userId=${ids[target]}`);
      expect(result.data).toEqual([]);
      expect(result.pagination.totalItems).toBe(0);
    }
    const erased = await reports(`userId=${ids.erased}`);
    expect(erased.data.map((row) => row.id)).toEqual(erasedReportIds);
    expect(erased.data.map((row) => row.id)).not.toContain(
      erasedCommentReportId,
    );
    expect((await reports(`userId=${randomUUID()}`)).data).toEqual([]);
  });
});

describe('audit trail filter by target', () => {
  async function actions(query: string, token = 'admin') {
    return get(token, `/admin/moderation-actions?${query}`);
  }

  it('lists the actions on one target, newest first', async () => {
    const userTarget = `targetType=USER&targetId=${ids.subject}`;
    const all = await actions(userTarget);
    expect(all.statusCode).toBe(200);
    const body = all.json() as {
      data: Array<{ id: string }>;
      pagination: { totalItems: number };
    };
    const expected = auditIds.slice(0, 3).reverse();
    expect(body.data.map((row) => row.id)).toEqual(expected);
    expect(body.pagination.totalItems).toBe(3);

    for (let page = 1; page <= 4; page += 1) {
      const one = (
        await actions(`${userTarget}&page=${page}&pageSize=1`)
      ).json() as {
        data: Array<{ id: string }>;
        pagination: { totalItems: number };
      };
      expect(one.pagination.totalItems).toBe(3);
      expect(one.data.map((row) => row.id)).toEqual(
        expected.slice(page - 1, page),
      );
    }

    const trip = (
      await actions(`targetType=TRIP&targetId=${ids.subject}`)
    ).json() as { data: Array<{ id: string }> };
    expect(trip.data.map((row) => row.id)).toEqual([auditIds[3]]);
    const unknown = (
      await actions(`targetType=USER&targetId=${randomUUID()}`)
    ).json() as { data: unknown[] };
    expect(unknown.data).toEqual([]);
  });

  it('stays administrators only', async () => {
    const response = await actions(
      `targetType=USER&targetId=${ids.subject}`,
      'moderator',
    );
    expect(response.statusCode).toBe(403);
    expect(codeOf(response)).toBe('ADMIN_ONLY');
  });
});

describe('account detail: failures, headers and limits', () => {
  it('replaces a database error with a fixed 500 and keeps it out of logs', async () => {
    const response = await detailOf('admin', ids.subject, failingApp);
    expect(response.statusCode).toBe(500);
    expect(codeOf(response)).toBe('INTERNAL_SERVER_ERROR');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(secret);
    expect(logText.join('')).not.toContain(secret);
    expect(logText.join('')).toContain('admin_user_query_failed');
  });

  it('sends no-store on success and on errors', async () => {
    const responses = [
      await detailOf('admin', ids.subject),
      await detailOf('admin', 'not-a-uuid'),
      await detailOf('user', ids.subject),
      await detailOf('admin', randomUUID()),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 400, 403, 404,
    ]);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('allows 60 detail requests a minute per account', async () => {
    for (let index = 0; index < 60; index += 1) {
      const response = await detailOf('adminRate', ids.noIdentity);
      expect(response.statusCode).toBe(200);
    }
    const limited = await detailOf('adminRate', ids.noIdentity);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
  });
});
