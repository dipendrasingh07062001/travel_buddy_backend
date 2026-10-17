import { publicObjectUrl } from '../../storage/object-storage.js';
import { publicText } from '../../privacy/public-text.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ageRange } from './profile.service.js';

export function presentPublicProfile(user: AuthenticatedUser) {
  return {
    id: user.id,
    displayName: publicText(user.displayName),
    ageRange: ageRange(user.birthDate),
    accountCreatedMonth: user.createdAt.toISOString().slice(0, 7),
    profilePhotoAvailable: Boolean(user.profile?.profilePhotoStorageKey),
    profilePhotoUrl: publicObjectUrl(user.profile?.profilePhotoStorageKey),
    homeCity: publicText(user.profile?.homeCity),
    homeRegion: publicText(user.profile?.homeRegion),
    biography: publicText(user.profile?.biography),
    languages: (user.profile?.languages ?? []).map((value) =>
      publicText(value),
    ),
    travelInterests: (user.profile?.travelInterests ?? []).map((value) =>
      publicText(value),
    ),
  };
}
