import type { AuthenticatedUser } from './auth.types.js';

export function presentAuthenticatedUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    displayName: user.displayName,
    birthDate: user.birthDate?.toISOString().slice(0, 10) ?? null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    profile: user.profile
      ? {
          profilePhotoAvailable: Boolean(user.profile.profilePhotoStorageKey),
          homeCity: user.profile.homeCity,
          homeRegion: user.profile.homeRegion,
          biography: user.profile.biography,
          languages: user.profile.languages,
          travelInterests: user.profile.travelInterests,
          pastTripsVisibility: user.profile.pastTripsVisibility,
          communityActivityVisibility: user.profile.communityActivityVisibility,
        }
      : null,
  };
}
