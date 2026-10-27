import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as EnvModule from '../src/config/env.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

// This file runs with the requirement switched on. Other suites cover the
// default, where a profile without a photo can do all three actions.
vi.mock('../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: { ...original.env, PROFILE_PHOTO_REQUIRED: true },
  };
});

const { buildApp } = await import('../src/app.js');
const { database } = await import('../src/database/client.js');

const subjects = {
  traveller: `photo-traveller-${randomUUID()}`,
  owner: `photo-owner-${randomUUID()}`,
};
const ids = { traveller: randomUUID(), owner: randomUUID() };
const communityId = randomUUID();
const draftTripId = randomUUID();
const openTripId = randomUUID();
const day = 86_400_000;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: subjects[token as keyof typeof subjects] ?? token,
      emailVerified: false,
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

function call(method: 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer traveller' },
    ...(payload && { payload }),
  });
}

function trip(id: string, ownerId: string, status: 'DRAFT' | 'PUBLISHED') {
  return {
    id,
    ownerId,
    communityId,
    originCity: 'Delhi',
    startDate: new Date(Date.now() + 30 * day),
    endDate: new Date(Date.now() + 32 * day),
    durationDays: 3,
    desiredGroupSize: 4,
    description: 'A trip used to test the profile photo requirement.',
    status,
    publishedAt: status === 'PUBLISHED' ? new Date() : null,
  };
}

const actions = {
  publish: () =>
    call('POST', `/trips/${draftTripId}/publish`, { expectedVersion: 1 }),
  request: () =>
    call('POST', `/trips/${openTripId}/connection-requests`, {
      message: 'I would love to join this trip with the group.',
    }),
  post: () =>
    call('POST', `/communities/${communityId}/posts`, {
      type: 'DISCUSSION',
      title: 'Planning question',
      body: 'Has anyone done this route recently in the winter?',
    }),
};

beforeAll(async () => {
  for (const account of ['traveller', 'owner'] as const) {
    await database.user.create({
      data: {
        id: ids[account],
        displayName: `Photo ${account}`,
        birthDate: new Date('1994-01-10T00:00:00.000Z'),
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subjects[account] },
        },
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'Weekend traveller who enjoys small group trips.',
            languages: ['english'],
            communityActivityVisibility: 'PUBLIC',
          },
        },
      },
    });
  }
  await database.community.create({
    data: {
      id: communityId,
      slug: `photo-required-${communityId}`,
      name: 'Photo Requirement Destination',
    },
  });
  await database.trip.createMany({
    data: [
      trip(draftTripId, ids.traveller, 'DRAFT'),
      trip(openTripId, ids.owner, 'PUBLISHED'),
    ],
  });
  await database.tripMembership.createMany({
    data: [
      { tripId: draftTripId, userId: ids.traveller, role: 'OWNER' },
      { tripId: openTripId, userId: ids.owner, role: 'OWNER' },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const userIds = Object.values(ids);
  await database.connectionRequest.deleteMany({
    where: { requesterId: { in: userIds } },
  });
  await database.communityPost.deleteMany({ where: { communityId } });
  await database.tripPublicationAlert.deleteMany({
    where: { tripId: { in: [draftTripId, openTripId] } },
  });
  await database.tripChange.deleteMany({
    where: { tripId: { in: [draftTripId, openTripId] } },
  });
  await database.tripMembership.deleteMany({
    where: { tripId: { in: [draftTripId, openTripId] } },
  });
  await database.trip.deleteMany({ where: { communityId } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.community.deleteMany({ where: { id: communityId } });
});

describe('profile photo requirement', () => {
  it.each(Object.entries(actions))(
    'blocks %s without a profile photo',
    async (_name, action) => {
      const response = await action();
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('PROFILE_INCOMPLETE');
      expect(response.json().error.message).toContain('profile photo');
    },
  );

  it('allows all three once the profile has a photo', async () => {
    await database.userProfile.update({
      where: { userId: ids.traveller },
      data: { profilePhotoStorageKey: `profile-photos/${ids.traveller}.webp` },
    });
    expect((await actions.publish()).statusCode).toBe(200);
    expect((await actions.request()).statusCode).toBe(201);
    expect((await actions.post()).statusCode).toBe(201);
  });
});
