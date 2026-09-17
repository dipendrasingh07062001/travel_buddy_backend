import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ageRange } from './profile.service.js';

export function presentPublicProfile(user: AuthenticatedUser) {
  return {
    id: user.id,
    displayName: user.displayName,
    ageRange: ageRange(user.birthDate),
    accountCreatedMonth: user.createdAt.toISOString().slice(0, 7),
    profilePhotoAvailable: Boolean(user.profile?.profilePhotoStorageKey),
    homeCity: user.profile?.homeCity ?? null,
    homeRegion: user.profile?.homeRegion ?? null,
    biography: user.profile?.biography ?? null,
    languages: user.profile?.languages ?? [],
    travelInterests: user.profile?.travelInterests ?? [],
  };
}
