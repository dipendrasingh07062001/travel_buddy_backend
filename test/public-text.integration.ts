import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { hiddenPublicText } from '../src/privacy/public-text.js';

const run = randomUUID();
const communityId = randomUUID();
const slug = `public-text-${run}`;
const userIds: string[] = [];
let ownerId = '';
let tripId = '';
let postId = '';
let commentId = '';
const email = 'privacy-traveller@example.invalid';
const phoneText = 'Call +91 98765 43210 for the private contact details.';
const description = 'Delhi to Manali for 3 people, budget INR 12000-18000.';
const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `public-text-${run}-${token}`,
      displayName: token === 'provider' ? email : `Privacy ${token}`,
      ...(token === 'provider' && { email }),
      emailVerified: token === 'provider',
    };
  },
};
const app = buildApp({ logger: false, auth: { tokenVerifier } });

function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
  role: 'owner' | 'peer' | 'provider' | null = 'owner',
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    ...(role && { headers: { authorization: `Bearer ${role}` } }),
    ...(payload && { payload }),
  });
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const tripBody = () => ({
  communityId,
  originCity: 'Delhi',
  startDate: day(30),
  endDate: day(35),
  desiredGroupSize: 3,
  description,
});
const countHistory = () => database.tripChange.count({ where: { tripId } });

function rejected(response: Awaited<ReturnType<typeof api>>, raw: string) {
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('PUBLIC_TEXT_PRIVACY_VIOLATION');
  expect(response.body).not.toContain(raw);
}

beforeAll(async () => {
  await app.ready();
  await database.community.create({
    data: { id: communityId, slug, name: 'Privacy Test Destination' },
  });
  for (const role of ['owner', 'peer'] as const) {
    const response = await api('POST', '/auth/bootstrap', undefined, role);
    expect(response.statusCode).toBe(201);
    const id = response.json().data.id as string;
    userIds.push(id);
    if (role === 'owner') ownerId = id;
    await database.user.update({
      where: { id },
      data: {
        birthDate: new Date('1995-05-20T00:00:00Z'),
        ...(role === 'owner' && { staffRole: 'ADMIN' }),
        profile: {
          create: {
            homeCity: 'Delhi',
            biography: 'A complete profile for privacy regression testing.',
            languages: ['english'],
            pastTripsVisibility: 'PUBLIC',
            communityActivityVisibility: 'PUBLIC',
          },
        },
      },
    });
  }
  const trip = await api('POST', '/trips', tripBody());
  expect(trip.statusCode).toBe(201);
  tripId = trip.json().data.id as string;
  const published = await api('POST', `/trips/${tripId}/publish`, {
    expectedVersion: 1,
  });
  expect(published.statusCode).toBe(200);
  const post = await api('POST', `/communities/${communityId}/posts`, {
    type: 'DISCUSSION',
    title: 'Planning an October weekend trek',
    body: description,
  });
  expect(post.statusCode).toBe(201);
  postId = post.json().data.id as string;
  const comment = await api('POST', `/community-posts/${postId}/comments`, {
    body: 'Meet at the public railway station.',
  });
  expect(comment.statusCode).toBe(201);
  commentId = comment.json().data.id as string;
}, 30_000);

afterAll(async () => {
  await app.close();
  await database.communityPost.deleteMany({ where: { communityId } });
  if (ownerId)
    await database.communityAdminAction.deleteMany({
      where: { actorId: ownerId },
    });
  await database.trip.deleteMany({ where: { communityId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  await database.$disconnect();
});

describe('public-text privacy writes and legacy public projections', () => {
  it.each([
    { displayName: email },
    { homeCity: email },
    { homeRegion: '9876543210' },
    { biography: phoneText },
    { languages: ['english', email] },
    { travelInterests: [email] },
  ])(
    'rejects unsafe profile fields before any database write',
    async (payload) => {
      const before = await database.user.findUniqueOrThrow({
        where: { id: ownerId },
        include: { profile: true },
      });
      const response = await api('PATCH', '/me/profile', payload);
      rejected(response, Object.values(payload).flat().at(-1)!);
      expect(
        await database.user.findUniqueOrThrow({
          where: { id: ownerId },
          include: { profile: true },
        }),
      ).toEqual(before);
    },
  );

  it('keeps provider email private and requests a new safe display name without breaking login', async () => {
    const response = await api(
      'POST',
      '/auth/bootstrap',
      undefined,
      'provider',
    );
    expect(response.statusCode).toBe(201);
    const id = response.json().data.id as string;
    userIds.push(id);
    expect(response.json().data.displayName).toBeNull();
    expect((await api('GET', '/me', undefined, 'provider')).statusCode).toBe(
      200,
    );
    const stored = await database.user.findUniqueOrThrow({
      where: { id },
      include: { identities: true },
    });
    expect(stored.displayName).toBeNull();
    expect(
      stored.identities.map((identity) => identity.normalizedValue),
    ).toContain(email);
  });

  it.each([{ description: phoneText }, { originCity: email }])(
    'rejects unsafe new trip fields before creating history or a trip',
    async (payload) => {
      const before = await database.trip.count({ where: { communityId } });
      rejected(
        await api('POST', '/trips', { ...tripBody(), ...payload }),
        Object.values(payload)[0]!,
      );
      expect(await database.trip.count({ where: { communityId } })).toBe(
        before,
      );
    },
  );

  it('rejects unsafe edits to a published trip without changing version or history', async () => {
    const before = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
    });
    const history = await countHistory();
    rejected(
      await api('PATCH', `/trips/${tripId}`, {
        expectedVersion: before.version,
        description: phoneText,
      }),
      phoneText,
    );
    expect(
      await database.trip.findUniqueOrThrow({ where: { id: tripId } }),
    ).toEqual(before);
    expect(await countHistory()).toBe(history);
  });

  it('rechecks legacy drafts/paused trips on publish but permits cancellation and correction', async () => {
    const created = await api('POST', '/trips', tripBody());
    const id = created.json().data.id as string;
    await database.trip.update({
      where: { id },
      data: { description: phoneText },
    });
    const before = await database.trip.findUniqueOrThrow({ where: { id } });
    rejected(
      await api('POST', `/trips/${id}/publish`, { expectedVersion: 1 }),
      phoneText,
    );
    expect(await database.trip.findUniqueOrThrow({ where: { id } })).toEqual(
      before,
    );
    expect(
      await database.tripPublicationAlert.count({ where: { tripId: id } }),
    ).toBe(0);
    expect(
      (await api('PATCH', `/trips/${id}`, { expectedVersion: 1, description }))
        .statusCode,
    ).toBe(200);
    expect(
      (await api('POST', `/trips/${id}/publish`, { expectedVersion: 2 }))
        .statusCode,
    ).toBe(200);
    await database.trip.update({
      where: { id },
      data: { status: 'PAUSED', description: phoneText },
    });
    rejected(
      await api('POST', `/trips/${id}/publish`, { expectedVersion: 3 }),
      phoneText,
    );
    expect(
      (await api('POST', `/trips/${id}/cancel`, { expectedVersion: 3 }))
        .statusCode,
    ).toBe(200);
  });

  it.each([
    { title: `Email ${email}`, body: description },
    { title: 'A safe travel discussion title', body: phoneText },
  ])(
    'rejects unsafe community post creation without persisting a row',
    async (payload) => {
      const before = await database.communityPost.count({
        where: { communityId },
      });
      rejected(
        await api('POST', `/communities/${communityId}/posts`, {
          type: 'DISCUSSION',
          ...payload,
        }),
        payload.body === phoneText ? phoneText : email,
      );
      expect(
        await database.communityPost.count({ where: { communityId } }),
      ).toBe(before);
    },
  );

  it('protects post and comment edits as well as comment creation', async () => {
    const beforePost = await database.communityPost.findUniqueOrThrow({
      where: { id: postId },
    });
    const beforeComment = await database.communityComment.findUniqueOrThrow({
      where: { id: commentId },
    });
    rejected(
      await api('PATCH', `/community-posts/${postId}`, { body: phoneText }),
      phoneText,
    );
    rejected(
      await api('POST', `/community-posts/${postId}/comments`, { body: email }),
      email,
    );
    rejected(
      await api('PATCH', `/community-comments/${commentId}`, { body: email }),
      email,
    );
    expect(
      await database.communityPost.findUniqueOrThrow({ where: { id: postId } }),
    ).toEqual(beforePost);
    expect(
      await database.communityComment.findUniqueOrThrow({
        where: { id: commentId },
      }),
    ).toEqual(beforeComment);
    expect(await database.communityComment.count({ where: { postId } })).toBe(
      1,
    );
  });

  it('validates public staff-managed metadata without blocking private admin notes', async () => {
    const before = await database.community.findUniqueOrThrow({
      where: { id: communityId },
    });
    const response = await api('PATCH', `/admin/communities/${communityId}`, {
      expectedVersion: before.version,
      description: phoneText,
      reason: 'Synthetic private note with contact ' + email,
    });
    rejected(response, phoneText);
    expect(
      await database.community.findUniqueOrThrow({
        where: { id: communityId },
      }),
    ).toEqual(before);
    const allowed = await api('PATCH', `/admin/communities/${communityId}`, {
      expectedVersion: before.version,
      description: 'Public destination information for ordinary travellers.',
      reason: 'Synthetic private review contact ' + email,
    });
    expect(allowed.statusCode).toBe(200);
    expect(
      (
        await database.communityAdminAction.findFirstOrThrow({
          where: { actorId: ownerId, communityId },
          orderBy: { createdAt: 'desc' },
        })
      ).reason,
    ).toContain(email);
    expect(
      (await api('GET', `/communities/${slug}`, undefined, null)).body,
    ).not.toContain(email);
  });

  it('does not apply public-text rules to accepted private chat', async () => {
    const request = await api(
      'POST',
      `/trips/${tripId}/connection-requests`,
      {
        message:
          'I would like to discuss joining this group on the planned dates.',
      },
      'peer',
    );
    expect(request.statusCode).toBe(201);
    expect(
      (
        await api(
          'POST',
          `/connection-requests/${request.json().data.id}/accept`,
        )
      ).statusCode,
    ).toBe(200);
    const response = await api(
      'POST',
      `/trips/${tripId}/messages`,
      { body: phoneText },
      'peer',
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().data.body).toBe(phoneText);
  });

  it('masks existing profile/trip text publicly without rewriting private owner data', async () => {
    await database.user.update({
      where: { id: ownerId },
      data: {
        displayName: email,
        profile: {
          update: { biography: phoneText, languages: ['english', email] },
        },
      },
    });
    await database.trip.update({
      where: { id: tripId },
      data: { originCity: email, description: phoneText },
    });
    const rawProfile = await database.user.findUniqueOrThrow({
      where: { id: ownerId },
      include: { profile: true },
    });
    const rawTrip = await database.trip.findUniqueOrThrow({
      where: { id: tripId },
    });
    const profile = await api('GET', `/users/${ownerId}`, undefined, null);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().data).toMatchObject({
      displayName: hiddenPublicText,
      biography: hiddenPublicText,
      languages: ['english', hiddenPublicText],
    });
    const trip = await api('GET', `/trips/${tripId}`, undefined, null);
    expect(trip.json().data).toMatchObject({
      originCity: hiddenPublicText,
      description: hiddenPublicText,
      owner: { displayName: hiddenPublicText },
    });
    expect(trip.body).not.toContain(email);
    expect(trip.body).not.toContain(phoneText);
    const list = await api(
      'GET',
      `/trips?destination=${slug}`,
      undefined,
      null,
    );
    expect(list.body).not.toContain(email);
    expect(list.body).not.toContain(phoneText);
    const me = await api('GET', '/me');
    expect(me.json().data.displayName).toBe(email);
    expect(me.json().data.profile.biography).toBe(phoneText);
    const owned = await api('GET', '/me/trips');
    expect(
      owned.json().data.find((item: { id: string }) => item.id === tripId),
    ).toMatchObject({ originCity: email, description: phoneText });
    expect(
      await database.user.findUniqueOrThrow({
        where: { id: ownerId },
        include: { profile: true },
      }),
    ).toEqual(rawProfile);
    expect(
      await database.trip.findUniqueOrThrow({ where: { id: tripId } }),
    ).toEqual(rawTrip);
  });

  it('covers community list/detail/comment and profile activity projections while keeping originals for staff', async () => {
    await database.communityPost.update({
      where: { id: postId },
      data: { title: `Email ${email}`, body: phoneText },
    });
    await database.communityComment.update({
      where: { id: commentId },
      data: { body: phoneText },
    });
    await database.community.update({
      where: { id: communityId },
      data: { name: email, description: phoneText },
    });
    const paths = [
      `/communities/${slug}`,
      `/communities/${slug}/posts`,
      `/communities/${slug}/trips`,
      `/community-posts/${postId}`,
      `/community-posts/${postId}/comments`,
      `/users/${ownerId}/trips`,
      `/users/${ownerId}/community-posts`,
      `/users/${ownerId}/community-comments`,
    ];
    for (const path of paths) {
      const response = await api('GET', path, undefined, null);
      expect(response.statusCode, path).toBe(200);
      expect(response.body, path).not.toContain(email);
      expect(response.body, path).not.toContain(phoneText);
      expect(response.body, path).toContain(hiddenPublicText);
    }
    const detail = await api(
      'GET',
      `/community-posts/${postId}`,
      undefined,
      null,
    );
    expect(detail.json().data).toMatchObject({
      title: hiddenPublicText,
      body: hiddenPublicText,
      author: { displayName: hiddenPublicText },
    });
    expect(
      (await api('GET', `/communities/${slug}/posts`, undefined, null)).json()
        .pagination.totalItems,
    ).toBe(1);
    expect(
      (
        await database.communityPost.findUniqueOrThrow({
          where: { id: postId },
        })
      ).body,
    ).toBe(phoneText);
    const staff = await api('GET', `/admin/communities/${communityId}`);
    expect(staff.statusCode).toBe(200);
    expect(staff.json().data).toMatchObject({
      name: email,
      description: phoneText,
    });
  });
});
