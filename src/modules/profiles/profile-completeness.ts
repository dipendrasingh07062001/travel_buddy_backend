import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';

type CompleteProfileUser = AuthenticatedUser & {
  displayName: string;
  birthDate: Date;
  profile: NonNullable<AuthenticatedUser['profile']>;
};

// Actions that expose a user to other travellers require a complete adult
// profile. The birth date is validated as 18+ when it is set, so requiring it
// here is what enforces the adult-only rule. A profile photo joins the list
// only when PROFILE_PHOTO_REQUIRED is on, which needs photo uploads to work.
export function requireCompleteProfile(
  user: AuthenticatedUser,
  activity: string,
): asserts user is CompleteProfileUser {
  const photoRequired = env.PROFILE_PHOTO_REQUIRED;
  if (
    !user.displayName ||
    !user.birthDate ||
    !user.profile?.homeCity ||
    !user.profile.biography ||
    user.profile.languages.length === 0 ||
    (photoRequired && !user.profile.profilePhotoStorageKey)
  ) {
    const fields = photoRequired
      ? 'display name, birth date, home city, biography, languages, and profile photo'
      : 'display name, birth date, home city, biography, and languages';
    throw new AppError(
      409,
      'PROFILE_INCOMPLETE',
      `Complete your ${fields} before ${activity}.`,
    );
  }
}
