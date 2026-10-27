import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EnvModule from '../src/config/env.js';
import type { AuthenticatedUser } from '../src/modules/auth/auth.types.js';

const settings = vi.hoisted(() => ({ photoRequired: false }));
vi.mock('../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      get PROFILE_PHOTO_REQUIRED() {
        return settings.photoRequired;
      },
    },
  };
});

const { envSchema } = await import('../src/config/env.js');
const { requireCompleteProfile } =
  await import('../src/modules/profiles/profile-completeness.js');

const storage = {
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_PUBLIC_BUCKET: 'travel-buddy-public',
  R2_PRIVATE_BUCKET: 'travel-buddy-private',
  R2_PUBLIC_BASE_URL: 'https://media.example.test',
};

function traveller(photo: string | null): AuthenticatedUser {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    displayName: 'Photo Traveller',
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: {
      profilePhotoStorageKey: photo,
      homeCity: 'Delhi',
      homeRegion: null,
      biography: 'Weekend traveller who enjoys small group trips.',
      languages: ['english'],
      travelInterests: [],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

describe('PROFILE_PHOTO_REQUIRED setting', () => {
  it('defaults to off', () => {
    expect(envSchema.parse({}).PROFILE_PHOTO_REQUIRED).toBe(false);
  });

  it('refuses to turn on without photo storage', () => {
    const result = envSchema.safeParse({ PROFILE_PHOTO_REQUIRED: 'true' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['PROFILE_PHOTO_REQUIRED'],
        message:
          'PROFILE_PHOTO_REQUIRED=true needs all six R2_* storage settings; otherwise nobody could upload the required photo.',
      }),
    );
  });

  it('turns on when photo storage is configured', () => {
    const result = envSchema.safeParse({
      ...storage,
      PROFILE_PHOTO_REQUIRED: 'true',
    });
    expect(result.success).toBe(true);
    expect(result.data?.PROFILE_PHOTO_REQUIRED).toBe(true);
  });
});

describe('profile completeness with the photo setting', () => {
  beforeEach(() => {
    settings.photoRequired = false;
  });

  it('does not ask for a photo while the setting is off', () => {
    expect(() =>
      requireCompleteProfile(traveller(null), 'publishing a trip'),
    ).not.toThrow();
  });

  it('asks for a photo, by name, while the setting is on', () => {
    settings.photoRequired = true;
    expect(() =>
      requireCompleteProfile(traveller(null), 'publishing a trip'),
    ).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'PROFILE_INCOMPLETE',
        message:
          'Complete your display name, birth date, home city, biography, languages, and profile photo before publishing a trip.',
      }),
    );
    expect(() =>
      requireCompleteProfile(
        traveller('profile-photos/user/photo.webp'),
        'publishing a trip',
      ),
    ).not.toThrow();
  });
});
