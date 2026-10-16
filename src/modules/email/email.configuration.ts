import type { EmailSender } from './email.types.js';

// Deliberate safe state until the founders select a provider and verify a
// sending domain. Do not replace this with a console/log "sender": it would
// leak addresses and could falsely mark real messages as sent.
export function configuredEmailSender(): EmailSender | null {
  return null;
}
export function emailDeliveryConfigured(): boolean {
  return configuredEmailSender() !== null;
}
