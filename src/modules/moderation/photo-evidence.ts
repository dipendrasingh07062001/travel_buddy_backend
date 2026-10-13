import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { database } from '../../database/client.js';
import type { ObjectStorage } from '../../storage/object-storage.js';

// Profile photos live in the public bucket and are deleted when replaced, so
// a reported or removed photo is copied into the private bucket for staff
// review and the audit trail. Returns the copy's key, or null if the photo
// is already gone or the copy failed (which is logged; moderation goes on).
export async function preservePhotoEvidence(
  storage: ObjectStorage,
  photoKey: string,
  logger: FastifyBaseLogger,
): Promise<string | null> {
  try {
    const body = await storage.getObject('public', photoKey);
    if (!body) return null;
    const evidenceKey = `moderation-evidence/profile-photos/${randomUUID()}.webp`;
    await storage.putObject({
      bucket: 'private',
      key: evidenceKey,
      body,
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });
    return evidenceKey;
  } catch (error) {
    logger.warn(
      { err: error, photoKey },
      'Could not preserve profile photo evidence',
    );
    return null;
  }
}

export async function attachReportEvidence(
  reportId: string,
  evidenceKey: string,
): Promise<void> {
  await database.report.update({
    where: { id: reportId },
    data: { evidenceStorageKey: evidenceKey },
  });
}
