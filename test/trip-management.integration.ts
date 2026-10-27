import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const ownerSubject = `trip-owner-${randomUUID()}`;
const otherSubject = `trip-other-${randomUUID()}`;
const communityId = randomUUID();
let ownerId: string | undefined;
let otherUserId: string | undefined;
let tripId: string | undefined;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: token === 'owner-token' ? ownerSubject : otherSubject,
      displayName: token === 'owner-token' ? 'Integration Owner' : 'Other User',
      emailVerified: false,
    };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });
const ownerHeaders = { authorization: 'Bearer owner-token' };
const otherHeaders = { authorization: 'Bearer other-token' };

beforeAll(async () => {
  await database.community.create({
    data: {
      id: communityId,
      slug: `trip-management-${communityId}`,
      name: 'Trip Management Community',
      region: 'Himachal Pradesh',
    },
  });
  await app.ready();

  const owner = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    headers: ownerHeaders,
  });
  const other = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    headers: otherHeaders,
  });
  const bootstrappedOwnerId = owner.json().data.id as string;
  ownerId = bootstrappedOwnerId;
  otherUserId = other.json().data.id;
  await database.user.update({
    where: { id: bootstrappedOwnerId },
    data: {
      birthDate: new Date('1995-05-20T00:00:00.000Z'),
      profile: {
        create: {
          homeCity: 'Delhi',
          biography: 'Integration profile for trip management testing.',
          languages: ['english'],
        },
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  if (tripId) await database.trip.deleteMany({ where: { id: tripId } });
  await database.community.deleteMany({ where: { id: communityId } });
  await database.user.deleteMany({
    where: { id: { in: [ownerId, otherUserId].filter(Boolean) as string[] } },
  });
  await database.$disconnect();
});

describe('trip management persistence and visibility', () => {
  it('persists an owner-controlled trip lifecycle without exposing drafts', async () => {
    const startDate = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const endDate = new Date(Date.now() + 35 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/trips',
      headers: ownerHeaders,
      payload: {
        communityId,
        originCity: 'Delhi',
        startDate,
        endDate,
        budgetMin: 12000,
        budgetMax: 18000,
        desiredGroupSize: 5,
        transport: 'BUS',
        description:
          'Integration trip for testing persistence and safe visibility.',
      },
    });
    expect(created.statusCode).toBe(201);
    tripId = created.json().data.id;

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}`,
    });
    expect(hidden.statusCode).toBe(404);

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: otherHeaders,
      payload: { expectedVersion: 1, desiredGroupSize: 6 },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('TRIP_FORBIDDEN');

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: ownerHeaders,
      payload: { expectedVersion: 1, desiredGroupSize: 6 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.version).toBe(2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}`,
      headers: ownerHeaders,
      payload: { expectedVersion: 1, desiredGroupSize: 7 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TRIP_VERSION_CONFLICT');

    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: ownerHeaders,
      payload: { expectedVersion: 2 },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe('PUBLISH_CONFIRMATION_REQUIRED');
    expect(
      await database.trip.findUniqueOrThrow({
        where: { id: tripId! },
        select: { status: true, version: true, publishConfirmedAt: true },
      }),
    ).toEqual({ status: 'DRAFT', version: 2, publishConfirmedAt: null });

    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: ownerHeaders,
      payload: { expectedVersion: 2, confirmsPersonalPlan: true },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({
      status: 'PUBLISHED',
      version: 3,
      publishConfirmation: { version: '2026-10-27' },
    });
    const firstConfirmedAt = published.json().data.publishConfirmation
      .confirmedAt as string;

    const visible = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}`,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().data.owner.id).toBe(ownerId);
    // The confirmation is for the owner and moderators, not the public.
    expect(visible.json().data.publishConfirmation).toBeUndefined();
    expect(JSON.stringify(visible.json())).not.toContain('publishConfirm');

    // Republishing after a pause records a fresh confirmation.
    await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/pause`,
      headers: ownerHeaders,
      payload: { expectedVersion: 3 },
    });
    const republished = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/publish`,
      headers: ownerHeaders,
      payload: { expectedVersion: 4, confirmsPersonalPlan: true },
    });
    expect(republished.statusCode).toBe(200);
    expect(
      Date.parse(republished.json().data.publishConfirmation.confirmedAt),
    ).toBeGreaterThan(Date.parse(firstConfirmedAt));

    const exported = await app.inject({
      method: 'POST',
      url: '/api/v1/me/data-export',
      headers: ownerHeaders,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().activity.trips).toContainEqual(
      expect.objectContaining({
        id: tripId,
        publishConfirmationVersion: '2026-10-27',
        publishConfirmedAt:
          republished.json().data.publishConfirmation.confirmedAt,
      }),
    );

    // The database keeps the time and the wording version together.
    await expect(
      database.trip.update({
        where: { id: tripId! },
        data: { publishConfirmationVersion: null },
      }),
    ).rejects.toThrow();

    const owned = await app.inject({
      method: 'GET',
      url: '/api/v1/me/trips?status=PUBLISHED',
      headers: ownerHeaders,
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().data.map((trip: { id: string }) => trip.id)).toContain(
      tripId,
    );
  });
});
