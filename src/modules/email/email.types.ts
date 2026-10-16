import type {
  EmailCategory,
  EmailPreference,
} from '../../generated/prisma/client.js';

export interface EmailSettings {
  connections: boolean;
  trips: boolean;
  finances: boolean;
  safety: boolean;
}
export type EmailPreferencePatch = Partial<EmailSettings>;
export interface EmailPreferenceRepository {
  find(userId: string): Promise<EmailPreference | null>;
  update(
    userId: string,
    expectedVersion: number,
    patch: EmailPreferencePatch,
  ): Promise<EmailPreference>;
}
export interface EmailPreferenceDependencies {
  repository: EmailPreferenceRepository;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  // A real adapter MUST enforce idempotency for the entire retry/expiry window.
  // Retries after a timeout/crash reuse this exact value.
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface EmailSender {
  // accepted = provider accepted, not proof of delivery. Never return/store raw
  // provider responses or log addresses, request bodies, credentials or tokens.
  send(message: EmailMessage): Promise<'accepted' | 'retry' | 'rejected'>;
}
export interface EmailRecipientResolver {
  // Resolve CURRENT provider-verified contact details. Historical AuthIdentity
  // rows are not a safe fallback. Return null if no verified eligible address.
  resolve(userId: string): Promise<string | null>;
}
export interface EmailDeliveryDependencies {
  sender: EmailSender;
  recipients: EmailRecipientResolver;
}
export type EmailCategoryField = keyof EmailSettings;
export const emailCategoryFields: Record<EmailCategory, EmailCategoryField> = {
  CONNECTIONS: 'connections',
  TRIPS: 'trips',
  FINANCES: 'finances',
  SAFETY: 'safety',
};
