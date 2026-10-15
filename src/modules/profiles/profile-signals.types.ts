import type { VerifiedIdentity } from '../auth/auth.types.js';

export interface VerificationRecord {
  type: 'EMAIL' | 'PHONE';
  recordedAt: Date;
}
export interface ProfileSignalsRepository {
  findPublic(
    userId: string,
    viewerId: string | undefined,
  ): Promise<VerificationRecord[] | null>;
  refresh(
    userId: string,
    identity: VerifiedIdentity,
  ): Promise<VerificationRecord[]>;
}
export interface ProfileSignalsDependencies {
  repository: ProfileSignalsRepository;
}
