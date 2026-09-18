import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';

const subject = `profile-integration-${randomUUID()}`;
let createdUserId: string | undefined;

const tokenVerifier: TokenVerifier = {
  async verify() {
    return {
      subject,
      displayName: 'Profile Integration User',
      emailVerified: false,
    };
  },
};

const app = buildApp({ logger: false, auth: { tokenVerifier } });

beforeAll(async () => app.ready());
afterAll(async () => {
  await app.close();
  if (createdUserId) {
    await database.user.deleteMany({ where: { id: createdUserId } });
  }
  await database.$disconnect();
});

describe('user profile persistence', () => {
  it('persists private fields and exposes only their safe public form', async () => {
    const headers = { authorization: 'Bearer integration-token' };
    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers,
    });
    createdUserId = bootstrap.json().data?.id;
    expect(bootstrap.statusCode).toBe(201);

    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers,
      payload: {
        displayName: 'Integration Traveller',
        birthDate: '1995-06-15',
        homeCity: 'Delhi',
        homeRegion: 'Delhi NCR',
        biography: 'Interested in mountain trips',
        languages: ['English', 'Hindi'],
        travelInterests: ['Trekking'],
        pastTripsVisibility: 'PRIVATE',
      },
    });
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    const publicProfile = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${createdUserId}`,
    });

    expect(update.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
    expect(me.json().data.birthDate).toBe('1995-06-15');
    expect(me.json().data.profile.pastTripsVisibility).toBe('PRIVATE');
    expect(publicProfile.statusCode).toBe(200);
    expect(publicProfile.json().data.birthDate).toBeUndefined();
    expect(publicProfile.json().data).toMatchObject({
      displayName: 'Integration Traveller',
      homeCity: 'Delhi',
      languages: ['english', 'hindi'],
    });

    if (!createdUserId) throw new Error('Bootstrap did not return a user id.');
    const stored = await database.user.findUnique({
      where: { id: createdUserId },
      include: { profile: true },
    });
    expect(stored?.birthDate?.toISOString().slice(0, 10)).toBe('1995-06-15');
    expect(stored?.profile?.pastTripsVisibility).toBe('PRIVATE');
  });

  it('enforces profile list limits inside PostgreSQL', async () => {
    if (!createdUserId) throw new Error('Profile test user was not created.');
    await expect(
      database.userProfile.update({
        where: { userId: createdUserId },
        data: {
          languages: Array.from({ length: 11 }, (_, index) => `lang-${index}`),
        },
      }),
    ).rejects.toThrow();
  });
});
