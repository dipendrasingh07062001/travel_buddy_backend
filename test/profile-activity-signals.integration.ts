import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { AppError } from '../src/errors/app-error.js';
import type { TripStatus } from '../src/generated/prisma/client.js';
import type {
  TokenVerifier,
  VerifiedIdentity,
} from '../src/modules/auth/auth.types.js';
import { prismaProfileSignalsRepository } from '../src/modules/profiles/profile-signals.repository.js';
import { utcStartOfToday } from '../src/modules/trips/trip.types.js';

const run = randomUUID();
const actors = ['target', 'friend', 'outsider', 'parent'] as const;
type Actor = (typeof actors)[number];
const ids = {} as Record<Actor, string>;
const claims = Object.fromEntries(
  actors.map((actor) => [
    actor,
    { subject: `profile-${actor}-${run}`, emailVerified: false },
  ]),
) as Record<Actor, VerifiedIdentity>;
const email = `profile-${run}@example.test`;
const friendEmail = `friend-${run}@example.test`;
const phone = `+918${Date.now().toString().slice(-9)}`;
claims.target = {
  ...claims.target,
  email,
  emailVerified: true,
  phoneNumber: phone,
};
claims.friend = { ...claims.friend, email: friendEmail, emailVerified: true };
const communityId = randomUUID();
const archivedId = randomUUID();
const trips: Record<string, string> = {};
const posts: Record<string, string> = {};
const comments: Record<string, string> = {};
const today = utcStartOfToday();
const date = (offset: number) =>
  new Date(today.getTime() + offset * 86_400_000);
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const identity = claims[token as Actor];
    if (!identity) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
    return { ...identity };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const paths = [
  'trips',
  'community-posts',
  'community-comments',
  'verification-signals',
] as const;
function api(
  path: string,
  actor?: Actor,
  method: 'GET' | 'POST' = 'GET',
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    ...(actor ? { headers: { authorization: `Bearer ${actor}` } } : {}),
    ...(payload && { payload }),
  });
}
async function activity(suffix: string, actor?: Actor) {
  const response = await api(`/users/${ids.target}/${suffix}`, actor);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  return response.json() as {
    data: Array<{ id: string; [key: string]: unknown }>;
    pagination: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  };
}
async function makeTrip(
  name: string,
  status: TripStatus,
  options: {
    ended?: boolean;
    archived?: boolean;
    moderated?: boolean;
    unpublished?: boolean;
    owner?: Actor;
    member?: Actor;
  } = {},
) {
  const owner = options.owner ?? 'target';
  const members = [
    { userId: ids[owner], role: 'OWNER' as const },
    ...(options.member && options.member !== owner
      ? [{ userId: ids[options.member], role: 'MEMBER' as const }]
      : []),
  ];
  const row = await database.trip.create({
    data: {
      ownerId: ids[owner],
      communityId: options.archived ? archivedId : communityId,
      originCity: 'Delhi',
      startDate: date(options.ended ? -10 : 30),
      endDate: date(options.ended ? -5 : 35),
      durationDays: 6,
      currentGroupSize: members.length,
      desiredGroupSize: 5,
      status,
      publishedAt: status === 'DRAFT' || options.unpublished ? null : date(-30),
      moderationRemovedAt: options.moderated ? today : null,
      description:
        'Private plan details must not be copied into profile activity cards.',
      memberships: { create: members },
    },
  });
  trips[name] = row.id;
}
async function makePost(
  name: string,
  options: {
    author?: Actor;
    archived?: boolean;
    draft?: boolean;
    removed?: boolean;
    unpublished?: boolean;
  } = {},
) {
  const row = await database.communityPost.create({
    data: {
      authorId: ids[options.author ?? 'target'],
      communityId: options.archived ? archivedId : communityId,
      type: 'DISCUSSION',
      status: options.draft
        ? 'DRAFT'
        : options.removed
          ? 'REMOVED'
          : 'PUBLISHED',
      title: `Activity post ${name}`,
      body: 'Body content is deliberately absent from profile activity cards.',
      publishedAt: options.draft || options.unpublished ? null : today,
      removedAt: options.removed ? today : null,
    },
  });
  posts[name] = row.id;
}
async function makeComment(name: string, postName: string, removed = false) {
  const row = await database.communityComment.create({
    data: {
      authorId: ids.target,
      postId: posts[postName]!,
      body: 'Comment body is deliberately absent from profile activity cards.',
      createdAt: today,
      status: removed ? 'REMOVED' : 'ACTIVE',
      removedAt: removed ? today : null,
    },
  });
  comments[name] = row.id;
}

beforeAll(async () => {
  await app.ready();
  for (const actor of actors) {
    const result = await api('/auth/bootstrap', actor, 'POST');
    expect(result.statusCode).toBe(201);
    ids[actor] = result.json().data.id as string;
    await database.user.update({
      where: { id: ids[actor] },
      data: {
        displayName: `Profile ${actor}`,
        birthDate: new Date('1995-05-20T00:00:00.000Z'),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Profile activity test traveller.',
            languages: ['english'],
            pastTripsVisibility: 'PUBLIC',
          },
        },
      },
    });
  }
  for (const id of [communityId, archivedId])
    await database.community.create({
      data: { id, slug: `profile-${id}`, name: 'Profile destination' },
    });
  await makeTrip('public', 'PUBLISHED');
  await makeTrip('full', 'FULL');
  await makeTrip('draft', 'DRAFT');
  await makeTrip('paused', 'PAUSED');
  await makeTrip('cancelled', 'CANCELLED');
  await makeTrip('ended', 'PUBLISHED', { ended: true });
  await makeTrip('removed', 'PUBLISHED', { moderated: true });
  await makeTrip('archived', 'PUBLISHED', { archived: true });
  await makeTrip('completedA', 'COMPLETED', { ended: true, member: 'friend' });
  await makeTrip('completedB', 'COMPLETED', { ended: true });
  await makeTrip('unpublishedCompleted', 'COMPLETED', {
    ended: true,
    unpublished: true,
  });
  await makeTrip('joinedOnly', 'PUBLISHED', {
    owner: 'friend',
    member: 'target',
  });
  await makePost('publicA');
  await makePost('publicB');
  await makePost('draft', { draft: true });
  await makePost('removed', { removed: true });
  await makePost('archived', { archived: true });
  await makePost('unpublished', { unpublished: true });
  await makePost('otherParent', { author: 'parent' });
  await makeComment('ownParent', 'publicA');
  await makeComment('otherParent', 'otherParent');
  await makeComment('removed', 'publicA', true);
  await makeComment('draftParent', 'draft');
  await makeComment('removedParent', 'removed');
  await makeComment('archived', 'archived');
  await database.community.update({
    where: { id: archivedId },
    data: { status: 'ARCHIVED' },
  });
  await database.authIdentity.create({
    data: {
      userId: ids.target,
      type: 'EMAIL',
      normalizedValue: `unverified-${run}@example.test`,
      verifiedAt: null,
    },
  });
  await database.authIdentity.create({
    data: {
      userId: ids.target,
      type: 'EMAIL',
      normalizedValue: `older-verified-${run}@example.test`,
      verifiedAt: date(-2),
    },
  });
});
beforeEach(async () => {
  await database.user.update({
    where: { id: ids.target },
    data: { status: 'ACTIVE', statusBeforeDeletion: null, deletedAt: null },
  });
  await database.userProfile.update({
    where: { userId: ids.target },
    data: {
      pastTripsVisibility: 'PUBLIC',
      communityActivityVisibility: 'PUBLIC',
    },
  });
  await database.user.update({
    where: { id: ids.parent },
    data: { status: 'ACTIVE', deletedAt: null },
  });
  await database.userProfile.update({
    where: { userId: ids.parent },
    data: { communityActivityVisibility: 'PUBLIC' },
  });
  await database.userBlock.deleteMany({
    where: { blockerId: { in: Object.values(ids) } },
  });
  await database.tripMembership.updateMany({
    where: { tripId: trips.completedA!, userId: ids.friend },
    data: { status: 'ACTIVE', leftAt: null },
  });
});
afterAll(async () => {
  await app.close();
  await database.trip.deleteMany({
    where: { id: { in: Object.values(trips) } },
  });
  await database.community.deleteMany({
    where: { id: { in: [communityId, archivedId] } },
  });
  await database.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await database.$disconnect();
});

describe('privacy-controlled profile activity', () => {
  it('lists authored upcoming public trips, not private states or joined participation', async () => {
    const result = await activity('trips');
    expect(result.data.map((item) => item.id)).toEqual(
      [trips.public, trips.full].sort(),
    );
    expect(result.pagination.totalItems).toBe(2);
    for (const item of result.data) {
      expect(item).not.toHaveProperty('description');
      expect(item).not.toHaveProperty('memberships');
      expect(item).not.toHaveProperty('budget');
    }
  });
  it('lists only published, non-removed completed trips when past activity is PUBLIC', async () => {
    const result = await activity('trips?period=past');
    expect(result.data.map((item) => item.id)).toEqual(
      [trips.completedA, trips.completedB].sort(),
    );
  });
  it('limits MEMBERS_ONLY past activity to trips the viewer still belongs to', async () => {
    await database.userProfile.update({
      where: { userId: ids.target },
      data: { pastTripsVisibility: 'MEMBERS_ONLY' },
    });
    expect((await activity('trips?period=past')).pagination.totalItems).toBe(0);
    expect((await activity('trips?period=past', 'outsider')).data).toEqual([]);
    expect(
      (await activity('trips?period=past', 'friend')).data.map(
        (item) => item.id,
      ),
    ).toEqual([trips.completedA]);
    await database.tripMembership.updateMany({
      where: { tripId: trips.completedA!, userId: ids.friend },
      data: { status: 'LEFT', leftAt: today },
    });
    expect(
      (await activity('trips?period=past', 'friend')).pagination.totalItems,
    ).toBe(0);
  });
  it('keeps PRIVATE past activity off public profiles even for their owner', async () => {
    await database.userProfile.update({
      where: { userId: ids.target },
      data: { pastTripsVisibility: 'PRIVATE' },
    });
    for (const actor of [undefined, 'target', 'friend'] as const)
      expect(
        (await activity('trips?period=past', actor)).pagination.totalItems,
      ).toBe(0);
    const own = await api('/me/trips?status=COMPLETED', 'target');
    expect(own.statusCode).toBe(200);
    expect(own.json().data.length).toBeGreaterThan(0);
  });
  it('returns only public post cards and eligible public comment-parent cards', async () => {
    expect(
      (await activity('community-posts')).data.map((item) => item.id),
    ).toEqual([posts.publicA, posts.publicB].sort());
    expect(
      (await activity('community-comments')).data.map((item) => item.id),
    ).toEqual([comments.ownParent, comments.otherParent].sort());
  });
  it.each(['PRIVATE', 'MEMBERS_ONLY'] as const)(
    'does not turn %s community activity into a new public feed',
    async (visibility) => {
      await database.userProfile.update({
        where: { userId: ids.target },
        data: { communityActivityVisibility: visibility },
      });
      for (const actor of [undefined, 'target', 'friend'] as const)
        for (const path of ['community-posts', 'community-comments']) {
          expect((await activity(path, actor)).pagination.totalItems).toBe(0);
        }
    },
  );
  it("respects the parent post author's privacy and account status for comments", async () => {
    await database.userProfile.update({
      where: { userId: ids.parent },
      data: { communityActivityVisibility: 'PRIVATE' },
    });
    expect(
      (await activity('community-comments')).data.map((item) => item.id),
    ).toEqual([comments.ownParent]);
    await database.userProfile.update({
      where: { userId: ids.parent },
      data: { communityActivityVisibility: 'PUBLIC' },
    });
    await database.user.update({
      where: { id: ids.parent },
      data: { status: 'SUSPENDED' },
    });
    expect(
      (await activity('community-comments')).data.map((item) => item.id),
    ).toEqual([comments.ownParent]);
  });
  it('hides comments beneath an author blocked by the identified viewer', async () => {
    await database.userBlock.create({
      data: { blockerId: ids.outsider, blockedId: ids.parent },
    });
    expect(
      (await activity('community-comments', 'outsider')).data.map(
        (item) => item.id,
      ),
    ).toEqual([comments.ownParent]);
  });
  it.each(['target', 'outsider'] as const)(
    'respects blocks in both directions: %s blocks the other',
    async (blocker) => {
      await database.userBlock.create({
        data: {
          blockerId: ids[blocker],
          blockedId: ids[blocker === 'target' ? 'outsider' : 'target'],
        },
      });
      for (const path of paths)
        expect(
          (await api(`/users/${ids.target}/${path}`, 'outsider')).statusCode,
        ).toBe(404);
    },
  );
  it.each(['SUSPENDED', 'PENDING_DELETION', 'DELETED'] as const)(
    'hides all activity and signals for a %s target',
    async (status) => {
      await database.user.update({
        where: { id: ids.target },
        data: {
          status,
          ...(status === 'PENDING_DELETION' && {
            statusBeforeDeletion: 'ACTIVE',
          }),
          ...(status === 'DELETED' && { deletedAt: today }),
        },
      });
      for (const path of paths)
        expect((await api(`/users/${ids.target}/${path}`)).statusCode).toBe(
          404,
        );
    },
  );
  it('paginates deterministically and keeps only visible totals on empty pages', async () => {
    for (const suffix of ['trips', 'community-posts', 'community-comments']) {
      const all = await activity(suffix);
      const idsAcrossPages: string[] = [];
      for (let page = 1; page <= all.pagination.totalItems; page++)
        idsAcrossPages.push(
          ...(await activity(`${suffix}?page=${page}&pageSize=1`)).data.map(
            (item) => item.id,
          ),
        );
      expect(idsAcrossPages).toEqual(all.data.map((item) => item.id));
      const empty = await activity(`${suffix}?page=999&pageSize=1`);
      expect(empty.data).toEqual([]);
      expect(empty.pagination.totalItems).toBe(all.pagination.totalItems);
    }
  });
});

describe('recorded verification signals and authenticated refresh', () => {
  it('exposes types, dates and explanations but no contacts, Firebase UID or birth date', async () => {
    const response = await api(`/users/${ids.target}/verification-signals`);
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .data.signals.map((signal: { type: string }) => signal.type),
    ).toEqual(['EMAIL', 'PHONE']);
    const serialized = JSON.stringify(response.json());
    for (const secret of [
      email,
      phone,
      claims.target.subject,
      '1995-05-20',
      'normalizedValue',
    ])
      expect(serialized).not.toContain(secret);
    expect(response.json().data.signals[0].recordedAt).toBeTruthy();
    expect(response.json().data.notice).toContain('not live identity checks');
  });
  it('returns no signals for an account without recorded verified claims', async () => {
    const response = await api(`/users/${ids.outsider}/verification-signals`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.signals).toEqual([]);
  });
  it('refreshes only authenticated claims, preserves contact IDs and keeps at most one signal per type', async () => {
    const previous = await database.authIdentity.findFirstOrThrow({
      where: { userId: ids.target, normalizedValue: email },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await api(
        '/me/verification-signals/refresh',
        'target',
        'POST',
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data.signals).toHaveLength(2);
    }
    const records = await database.authIdentity.findMany({
      where: { userId: ids.target },
    });
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.type === 'EMAIL')?.id).toBe(
      previous.id,
    );
  });
  it('rejects a forged request body instead of accepting self-declared verification', async () => {
    const response = await api(
      '/me/verification-signals/refresh',
      'target',
      'POST',
      {
        emailVerified: true,
        phoneNumber: '+919999999999',
        userId: ids.outsider,
      },
    );
    expect(response.statusCode).toBe(400);
    expect(
      await database.authIdentity.count({ where: { userId: ids.outsider } }),
    ).toBe(0);
  });

  it('normalizes a changed verified contact and removes the previous local contact', async () => {
    const old = claims.target;
    const changed = `changed-${run}@example.test`;
    claims.target = {
      ...old,
      email: `  ${changed.toUpperCase()}  `,
      emailVerified: true,
    };
    try {
      const response = await api(
        '/me/verification-signals/refresh',
        'target',
        'POST',
      );
      expect(response.statusCode).toBe(200);
      expect(
        await database.authIdentity.count({
          where: { userId: ids.target, normalizedValue: changed },
        }),
      ).toBe(1);
      expect(
        await database.authIdentity.count({
          where: { userId: ids.target, normalizedValue: email },
        }),
      ).toBe(0);
    } finally {
      claims.target = old;
      expect(
        (await api('/me/verification-signals/refresh', 'target', 'POST'))
          .statusCode,
      ).toBe(200);
    }
  });
  it('removes stale records when refreshed verified claims no longer contain contacts', async () => {
    const old = claims.target;
    claims.target = {
      subject: old.subject,
      email: old.email!,
      emailVerified: false,
    };
    try {
      const response = await api(
        '/me/verification-signals/refresh',
        'target',
        'POST',
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data.signals).toEqual([]);
      expect(
        await database.authIdentity.count({ where: { userId: ids.target } }),
      ).toBe(0);
    } finally {
      claims.target = old;
      expect(
        (await api('/me/verification-signals/refresh', 'target', 'POST'))
          .statusCode,
      ).toBe(200);
    }
  });
  it('does not steal or auto-link a verified contact already owned by another local account', async () => {
    const old = claims.target;
    claims.target = { ...old, email: friendEmail, emailVerified: true };
    try {
      const response = await api(
        '/me/verification-signals/refresh',
        'target',
        'POST',
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('IDENTITY_ALREADY_LINKED');
      expect(
        await database.authIdentity.count({
          where: { userId: ids.target, normalizedValue: email },
        }),
      ).toBe(1);
      expect(
        await database.authIdentity.count({
          where: { userId: ids.friend, normalizedValue: friendEmail },
        }),
      ).toBe(1);
    } finally {
      claims.target = old;
    }
  });
  it('cannot recreate contacts if account state or the sign-in link changed after authentication', async () => {
    await database.user.update({
      where: { id: ids.target },
      data: { status: 'PENDING_DELETION', statusBeforeDeletion: 'ACTIVE' },
    });
    await database.authIdentity.deleteMany({ where: { userId: ids.target } });
    await expect(
      prismaProfileSignalsRepository.refresh(ids.target, claims.target),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await database.authIdentity.count({ where: { userId: ids.target } }),
    ).toBe(0);
    await database.user.update({
      where: { id: ids.target },
      data: { status: 'ACTIVE', statusBeforeDeletion: null },
    });
    await expect(
      prismaProfileSignalsRepository.refresh(ids.target, {
        subject: `different-${run}`,
        emailVerified: true,
        email,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await database.authIdentity.count({ where: { userId: ids.target } }),
    ).toBe(0);
  });
});
