import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ids = {
  admin: randomUUID(),
  moderator: randomUUID(),
  member: randomUUID(),
  owner: randomUUID(),
  source: randomUUID(),
  target: randomUUID(),
  empty: randomUUID(),
  final: randomUUID(),
  trip: randomUUID(),
  post: randomUUID(),
};
const subjects = {
  admin: `community-admin-${randomUUID()}`,
  moderator: `community-moderator-${randomUUID()}`,
  member: `community-member-${randomUUID()}`,
  owner: `community-owner-${randomUUID()}`,
};
const slug = {
  source: `duplicate-${ids.source}`,
  target: `canonical-${ids.target}`,
  empty: `empty-${ids.empty}`,
  final: `final-${ids.final}`,
  created: `created-${randomUUID()}`,
};
let createdId: string | undefined;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    const subject = subjects[token as keyof typeof subjects] ?? token;
    return { subject, emailVerified: false };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  for (const key of Object.keys(subjects) as Array<keyof typeof subjects>) {
    await database.user.create({
      data: {
        id: ids[key],
        displayName: `Community ${key}`,
        staffRole:
          key === 'admin'
            ? 'ADMIN'
            : key === 'moderator'
              ? 'MODERATOR'
              : 'USER',
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[key] },
        },
      },
    });
  }
  await database.community.createMany({
    data: [
      { id: ids.source, slug: slug.source, name: 'Duplicate Destination' },
      { id: ids.target, slug: slug.target, name: 'Canonical Destination' },
      { id: ids.empty, slug: slug.empty, name: 'Empty Destination' },
      { id: ids.final, slug: slug.final, name: 'Final Destination' },
    ],
  });
  await database.communityFollow.createMany({
    data: [
      { communityId: ids.source, userId: ids.member },
      { communityId: ids.source, userId: ids.owner },
      { communityId: ids.target, userId: ids.member },
    ],
  });
  const startDate = new Date(Date.now() + 30 * 86_400_000);
  const endDate = new Date(Date.now() + 33 * 86_400_000);
  await database.trip.create({
    data: {
      id: ids.trip,
      ownerId: ids.owner,
      communityId: ids.source,
      originCity: 'Delhi',
      startDate,
      endDate,
      durationDays: 4,
      desiredGroupSize: 2,
      description: 'A public trip for destination merge testing.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  await database.communityPost.create({
    data: {
      id: ids.post,
      communityId: ids.source,
      authorId: ids.owner,
      type: 'DISCUSSION',
      status: 'PUBLISHED',
      title: 'Destination question',
      body: 'A published discussion for the destination merge test.',
      publishedAt: new Date(),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const communityIds: string[] = [ids.source, ids.target, ids.empty, ids.final];
  if (createdId) communityIds.push(createdId);
  await database.communityAdminAction.deleteMany({
    where: { communityId: { in: communityIds } },
  });
  await database.communityFollow.deleteMany({
    where: { communityId: { in: communityIds } },
  });
  await database.communityPost.deleteMany({ where: { id: ids.post } });
  await database.trip.deleteMany({ where: { id: ids.trip } });
  await database.community.updateMany({
    where: { id: { in: communityIds } },
    data: { mergedIntoId: null },
  });
  await database.community.deleteMany({
    where: { id: { in: communityIds } },
  });
  await database.user.deleteMany({
    where: { id: { in: [ids.admin, ids.moderator, ids.member, ids.owner] } },
  });
  await database.$disconnect();
});

describe('destination community administration', () => {
  it('allows only active administrators to inspect and change communities', async () => {
    const guest = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communities',
    });
    const user = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communities',
      headers: headers('member'),
    });
    const moderator = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communities',
      headers: headers('moderator'),
    });
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communities?status=ACTIVE&pageSize=5',
      headers: headers('admin'),
    });
    expect(guest.statusCode).toBe(401);
    expect(user.statusCode).toBe(403);
    expect(moderator.statusCode).toBe(403);
    expect(admin.statusCode).toBe(200);
    expect(
      admin.json().data.some((item: { id: string }) => item.id === ids.source),
    ).toBe(true);
    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/community-actions',
      headers: headers('member'),
    });
    expect(audit.statusCode).toBe(403);
  });

  it('creates, edits, archives and reactivates an empty community with audit records', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/communities',
      headers: headers('admin'),
      payload: {
        slug: slug.created.toUpperCase(),
        name: '  New Destination  ',
      },
    });
    expect(created.statusCode).toBe(201);
    createdId = created.json().data.id as string;
    expect(created.json().data.slug).toBe(slug.created);
    expect(created.json().data.version).toBe(1);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/communities',
      headers: headers('admin'),
      payload: { slug: slug.created, name: 'Another Destination' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('COMMUNITY_SLUG_TAKEN');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/communities/${createdId}`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 1,
        name: ' Updated Destination ',
        region: 'Himachal Pradesh',
        reason: 'Correcting the destination metadata.',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.version).toBe(2);
    expect(updated.json().data.name).toBe('Updated Destination');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/communities/${createdId}`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 1,
        name: 'Stale',
        reason: 'A stale update is rejected.',
      },
    });
    expect(stale.statusCode).toBe(409);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${createdId}/archive`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 2,
        reason: 'This destination is not needed.',
      },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.status).toBe('ARCHIVED');
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug.created}`,
    });
    expect(hidden.statusCode).toBe(404);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${createdId}/reactivate`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 3,
        reason: 'The destination is valid again.',
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.status).toBe('ACTIVE');
    const actions = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/community-actions?communityId=${createdId}`,
      headers: headers('admin'),
    });
    expect(actions.statusCode).toBe(200);
    expect(
      actions.json().data.map((item: { action: string }) => item.action),
    ).toEqual(['REACTIVATED', 'ARCHIVED', 'UPDATED', 'CREATED']);
  });

  it('refuses to archive a destination that still owns trips, posts or follows', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${ids.source}/archive`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 1,
        reason: 'Attempting to archive populated content.',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COMMUNITY_NOT_EMPTY');
  });

  it('merges a duplicate without losing trips, posts, followers or old public links', async () => {
    const wrongVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${ids.source}/merge`,
      headers: headers('admin'),
      payload: {
        targetCommunityId: ids.target,
        expectedVersion: 1,
        expectedTargetVersion: 99,
        reason: 'Attempting a stale destination merge.',
      },
    });
    expect(wrongVersion.statusCode).toBe(409);
    expect(
      (
        await database.community.findUniqueOrThrow({
          where: { id: ids.source },
        })
      ).status,
    ).toBe('ACTIVE');

    const merged = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${ids.source}/merge`,
      headers: headers('admin'),
      payload: {
        targetCommunityId: ids.target,
        expectedVersion: 1,
        expectedTargetVersion: 1,
        reason: 'These names describe the same destination.',
      },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data.version).toBe(2);
    expect(merged.json().data._count).toMatchObject({
      trips: 1,
      posts: 1,
      followers: 2,
    });
    const source = await database.community.findUniqueOrThrow({
      where: { id: ids.source },
    });
    expect(source.status).toBe('ARCHIVED');
    expect(source.mergedIntoId).toBe(ids.target);
    expect(
      (await database.trip.findUniqueOrThrow({ where: { id: ids.trip } }))
        .communityId,
    ).toBe(ids.target);
    expect(
      (
        await database.communityPost.findUniqueOrThrow({
          where: { id: ids.post },
        })
      ).communityId,
    ).toBe(ids.target);

    const oldLink = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug.source}`,
    });
    const oldTrips = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug.source}/trips`,
    });
    const oldPosts = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug.source}/posts`,
    });
    expect(oldLink.statusCode).toBe(200);
    expect(oldLink.json().data.slug).toBe(slug.target);
    expect(
      oldTrips.json().data.map((item: { id: string }) => item.id),
    ).toContain(ids.trip);
    expect(
      oldPosts.json().data.map((item: { id: string }) => item.id),
    ).toContain(ids.post);

    const audit = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/community-actions?communityId=${ids.source}`,
      headers: headers('admin'),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data[0]).toMatchObject({
      action: 'MERGED',
      details: {
        tripsMoved: 1,
        postsMoved: 1,
        followersMoved: 2,
        duplicateFollows: 1,
      },
    });
    const followArchived = await app.inject({
      method: 'POST',
      url: `/api/v1/communities/${ids.source}/follow`,
      headers: headers('member'),
    });
    expect(followArchived.statusCode).toBe(404);
    const reactivate = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${ids.source}/reactivate`,
      headers: headers('admin'),
      payload: {
        expectedVersion: 2,
        reason: 'Trying to undo a completed merge.',
      },
    });
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.json().error.code).toBe('COMMUNITY_ALREADY_MERGED');

    // A second merge must also redirect the original slug, not leave a chain.
    const secondMerge = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/communities/${ids.target}/merge`,
      headers: headers('admin'),
      payload: {
        targetCommunityId: ids.final,
        expectedVersion: 2,
        expectedTargetVersion: 1,
        reason: 'Consolidating another duplicate destination.',
      },
    });
    expect(secondMerge.statusCode).toBe(200);
    expect(secondMerge.json().data._count).toMatchObject({
      trips: 1,
      posts: 1,
      followers: 2,
    });
    expect(
      (
        await database.community.findUniqueOrThrow({
          where: { id: ids.source },
        })
      ).mergedIntoId,
    ).toBe(ids.final);
    const originalLink = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${slug.source}`,
    });
    expect(originalLink.statusCode).toBe(200);
    expect(originalLink.json().data.slug).toBe(slug.final);
  });
});
