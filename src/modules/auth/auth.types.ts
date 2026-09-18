import type { ProfileVisibility, UserStatus } from '@prisma/client';

export interface VerifiedIdentity {
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified: boolean;
  phoneNumber?: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export interface AuthenticatedUser {
  id: string;
  displayName: string | null;
  birthDate: Date | null;
  status: UserStatus;
  createdAt: Date;
  profile: {
    profilePhotoStorageKey: string | null;
    homeCity: string | null;
    homeRegion: string | null;
    biography: string | null;
    languages: string[];
    travelInterests: string[];
    pastTripsVisibility: ProfileVisibility;
    communityActivityVisibility: ProfileVisibility;
  } | null;
}

export interface BootstrapResult {
  user: AuthenticatedUser;
  created: boolean;
}

export interface AuthRepository {
  bootstrapFirebaseUser(identity: VerifiedIdentity): Promise<BootstrapResult>;
  findFirebaseUser(subject: string): Promise<AuthenticatedUser | null>;
}

export interface AuthRouteDependencies {
  tokenVerifier: TokenVerifier;
  repository: AuthRepository;
}
