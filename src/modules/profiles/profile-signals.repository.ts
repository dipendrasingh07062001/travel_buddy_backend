import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import { verifiedContacts } from '../auth/auth.repository.js';
import { withVisibleProfile } from './profile-visibility.js';
import type { ProfileSignalsRepository } from './profile-signals.types.js';

export const prismaProfileSignalsRepository: ProfileSignalsRepository = {
  findPublic(userId, viewerId) {
    return withVisibleProfile(userId, viewerId, async (tx) => {
      // Read only signal type and date, never contact values. Multiple contact
      // records of the same type must not disclose their count to visitors.
      const rows = await tx.authIdentity.groupBy({
        by: ['type'],
        where: { userId, verifiedAt: { not: null } },
        _max: { verifiedAt: true },
        orderBy: { type: 'asc' },
      });
      return rows.flatMap((row) =>
        row._max.verifiedAt
          ? [{ type: row.type, recordedAt: row._max.verifiedAt }]
          : [],
      );
    });
  },
  async refresh(userId, identity) {
    const contacts = verifiedContacts(identity);
    try {
      return await database.$transaction(async (tx) => {
        // This write locks the account row, serializing refreshes with account
        // erasure. A previously authenticated request cannot recreate contacts
        // after the account becomes pending/deleted or its sign-in link is gone.
        const account = await tx.user.updateMany({
          where: {
            id: userId,
            status: 'ACTIVE',
            deletedAt: null,
            authAccounts: {
              some: { provider: 'FIREBASE', providerSubject: identity.subject },
            },
          },
          data: { updatedAt: new Date() },
        });
        if (account.count !== 1)
          throw new AppError(
            403,
            'ACCOUNT_DISABLED',
            'This account cannot refresh verification records.',
          );
        for (const type of ['EMAIL', 'PHONE'] as const) {
          const contact = contacts.find((item) => item.type === type);
          await tx.authIdentity.deleteMany({
            where: {
              userId,
              type,
              ...(contact && {
                normalizedValue: { not: contact.normalizedValue },
              }),
            },
          });
          if (!contact) continue;
          const updated = await tx.authIdentity.updateMany({
            where: { userId, type, normalizedValue: contact.normalizedValue },
            data: { verifiedAt: contact.verifiedAt },
          });
          if (updated.count === 0)
            await tx.authIdentity.create({ data: { userId, ...contact } });
        }
        return contacts.map((contact) => ({
          type: contact.type,
          recordedAt: contact.verifiedAt,
        }));
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(
          409,
          'IDENTITY_ALREADY_LINKED',
          'A verified contact is already linked to another account.',
        );
      }
      throw error;
    }
  },
};
