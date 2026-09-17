import type { ProfileVisibility } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types.js';

export interface UpdateProfileInput {
  displayName?: string;
  birthDate?: Date;
  homeCity?: string | null;
  homeRegion?: string | null;
  biography?: string | null;
  languages?: string[];
  travelInterests?: string[];
  pastTripsVisibility?: ProfileVisibility;
  communityActivityVisibility?: ProfileVisibility;
}

export interface ProfileRepository {
  update(userId: string, input: UpdateProfileInput): Promise<AuthenticatedUser>;
  findPublicByUserId(userId: string): Promise<AuthenticatedUser | null>;
}

export interface ProfileRouteDependencies {
  repository: ProfileRepository;
}
