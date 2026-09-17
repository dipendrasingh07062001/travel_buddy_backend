import { Prisma, type IdentityType } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  VerifiedIdentity,
} from './auth.types.js';

const publicUserSelect = {
  id: true,
  displayName: true,
  status: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

function verifiedContacts(identity: VerifiedIdentity) {
  const contacts: Array<{
    type: IdentityType;
    normalizedValue: string;
    verifiedAt: Date;
  }> = [];
  const verifiedAt = new Date();

  if (identity.email && identity.emailVerified) {
    contacts.push({
      type: 'EMAIL',
      normalizedValue: identity.email.trim().toLowerCase(),
      verifiedAt,
    });
  }
  if (identity.phoneNumber) {
    contacts.push({
      type: 'PHONE',
      normalizedValue: identity.phoneNumber,
      verifiedAt,
    });
  }
  return contacts;
}

async function findFirebaseUser(
  subject: string,
): Promise<AuthenticatedUser | null> {
  const account = await database.authAccount.findUnique({
    where: {
      provider_providerSubject: {
        provider: 'FIREBASE',
        providerSubject: subject,
      },
    },
    select: { user: { select: publicUserSelect } },
  });
  return account?.user ?? null;
}

export const prismaAuthRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    const existing = await findFirebaseUser(identity.subject);
    if (existing) {
      return { user: existing, created: false };
    }

    try {
      const user = await database.user.create({
        data: {
          displayName: identity.displayName?.trim().slice(0, 100) || null,
          authAccounts: {
            create: {
              provider: 'FIREBASE',
              providerSubject: identity.subject,
            },
          },
          identities: { create: verifiedContacts(identity) },
        },
        select: publicUserSelect,
      });
      return { user, created: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const racedUser = await findFirebaseUser(identity.subject);
        if (racedUser) {
          return { user: racedUser, created: false };
        }
        throw new AppError(
          409,
          'IDENTITY_ALREADY_LINKED',
          'A verified contact from this identity is already linked to another account.',
        );
      }
      throw error;
    }
  },

  findFirebaseUser,
};
