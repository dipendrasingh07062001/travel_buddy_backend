import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  ProfileRepository,
  UpdateProfileInput,
} from '../src/modules/profiles/profile.types.js';
import { ageRange } from '../src/modules/profiles/profile.service.js';

const userId = '50000000-0000-4000-8000-000000000001';
let user: AuthenticatedUser = {
  id: userId,
  displayName: 'Profile User',
  birthDate: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-10T00:00:00.000Z'),
  profile: null,
};
let updateCalls = 0;

const tokenVerifier: TokenVerifier = {
  async verify() {
    return { subject: 'profile-subject', emailVerified: false };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser() {
    return { user, created: false };
  },
  async findFirebaseUser() {
    return user;
  },
};

const profileRepository: ProfileRepository = {
  async update(_userId: string, input: UpdateProfileInput) {
    updateCalls += 1;
    user = {
      ...user,
      ...(input.displayName !== undefined && {
        displayName: input.displayName,
      }),
      ...(input.birthDate !== undefined && { birthDate: input.birthDate }),
      profile: {
        profilePhotoStorageKey: null,
        homeCity: input.homeCity ?? user.profile?.homeCity ?? null,
        homeRegion: input.homeRegion ?? user.profile?.homeRegion ?? null,
        biography: input.biography ?? user.profile?.biography ?? null,
        languages: input.languages ?? user.profile?.languages ?? [],
        travelInterests:
          input.travelInterests ?? user.profile?.travelInterests ?? [],
        pastTripsVisibility:
          input.pastTripsVisibility ??
          user.profile?.pastTripsVisibility ??
          'MEMBERS_ONLY',
        communityActivityVisibility:
          input.communityActivityVisibility ??
          user.profile?.communityActivityVisibility ??
          'PUBLIC',
      },
    };
    return user;
  },
  async findPublicByUserId(requestedId) {
    return requestedId === userId ? user : null;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  profiles: { repository: profileRepository },
});

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('user profile HTTP contract', () => {
  it('requires authentication to edit a profile', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      payload: { homeCity: 'Delhi' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects users younger than 18 before writing', async () => {
    const callsBefore = updateCalls;
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: { authorization: 'Bearer valid-token' },
      payload: { birthDate: new Date().toISOString().slice(0, 10) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('AGE_RESTRICTION');
    expect(updateCalls).toBe(callsBefore);
  });

  it('normalizes and updates private profile information', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        displayName: '  Priya Sharma  ',
        birthDate: '1996-05-20',
        homeCity: '  Delhi  ',
        homeRegion: 'Delhi NCR',
        biography: 'Weekend trek enthusiast',
        languages: ['English', 'hindi', 'ENGLISH'],
        travelInterests: ['Trekking', 'Food'],
        pastTripsVisibility: 'MEMBERS_ONLY',
        communityActivityVisibility: 'PRIVATE',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: userId,
      displayName: 'Priya Sharma',
      birthDate: '1996-05-20',
      profile: {
        profilePhotoAvailable: false,
        homeCity: 'Delhi',
        languages: ['english', 'hindi'],
        travelInterests: ['trekking', 'food'],
        communityActivityVisibility: 'PRIVATE',
      },
    });
  });

  it('returns a safe public profile without private fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${userId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: userId,
      displayName: 'Priya Sharma',
      accountCreatedMonth: '2026-01',
      homeCity: 'Delhi',
    });
    expect(response.json().data.birthDate).toBeUndefined();
    expect(response.json().data.pastTripsVisibility).toBeUndefined();
    expect(response.json().data.profilePhotoStorageKey).toBeUndefined();
  });

  it('calculates age ranges without revealing the birth date', () => {
    const today = new Date('2026-09-17T00:00:00.000Z');
    expect(ageRange(new Date('2002-09-18T00:00:00.000Z'), today)).toBe('18-24');
    expect(ageRange(new Date('1991-09-17T00:00:00.000Z'), today)).toBe('35-44');
  });

  it('returns 404 for a missing public profile', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/50000000-0000-4000-8000-000000000099',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
