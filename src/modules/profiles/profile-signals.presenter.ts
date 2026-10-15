import type { VerificationRecord } from './profile-signals.types.js';

export const verificationNotice =
  'These are previously recorded Firebase sign-in claims, not live identity checks, trust scores, or assurances of safety or conduct.';

export function presentVerificationSignals(records: VerificationRecord[]) {
  return {
    signals: records.map((record) => ({
      type: record.type,
      label:
        record.type === 'EMAIL'
          ? 'Email verification recorded'
          : 'Phone verification recorded',
      recordedAt: record.recordedAt.toISOString(),
      source: 'FIREBASE_SIGN_IN_CLAIM',
      explanation:
        record.type === 'EMAIL'
          ? 'The backend observed a verified-email claim from Firebase at the recorded time.'
          : 'The backend observed a phone-number claim from Firebase at the recorded time.',
      limitations:
        'This does not reveal the contact, independently verify identity, or guarantee continued contact ownership, intentions, conduct, or safety.',
    })),
    notice: verificationNotice,
  };
}
