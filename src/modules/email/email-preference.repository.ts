import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import type { EmailPreferenceRepository } from './email.types.js';

export const prismaEmailPreferenceRepository: EmailPreferenceRepository = {
  find(userId) {
    return database.emailPreference.findUnique({ where: { userId } });
  },
  update(userId, expectedVersion, patch) {
    return database.$transaction(async (tx) => {
      const active = await tx.user.updateMany({
        where: { id: userId, status: 'ACTIVE', deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (active.count !== 1)
        throw new AppError(
          403,
          'ACCOUNT_DISABLED',
          'This account is not active.',
        );
      const before = await tx.emailPreference.findUnique({ where: { userId } });
      if ((before?.version ?? 0) !== expectedVersion)
        throw new AppError(
          409,
          'EMAIL_PREFERENCE_VERSION_CONFLICT',
          'Email preferences changed. Refresh them before updating.',
        );
      const record = before
        ? await tx.emailPreference.update({
            where: { userId },
            data: { ...patch, version: { increment: 1 } },
          })
        : await tx.emailPreference.create({ data: { userId, ...patch } });
      // A consent change never replays queued events under the new consent.
      // In-flight provider requests cannot be recalled; worker preflight checks
      // the new version again immediately before starting each send.
      await tx.emailDelivery.updateMany({
        where: { status: 'PENDING', notification: { recipientId: userId } },
        data: { status: 'SKIPPED' },
      });
      return record;
    });
  },
};
