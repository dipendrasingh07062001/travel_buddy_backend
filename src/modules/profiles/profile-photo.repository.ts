import { database } from '../../database/client.js';
import { authenticatedUserSelect } from '../auth/auth.repository.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';

export interface ProfilePhotoChange {
  user: AuthenticatedUser;
  previousKey: string | null;
}

// Locks the user row so concurrent uploads each see the key they replace and
// no stored photo is left without a reference.
export function setProfilePhotoKey(
  userId: string,
  storageKey: string | null,
): Promise<ProfilePhotoChange> {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const previous = await transaction.userProfile.findUnique({
      where: { userId },
      select: { profilePhotoStorageKey: true },
    });
    if (storageKey !== null || previous) {
      await transaction.userProfile.upsert({
        where: { userId },
        create: { userId, profilePhotoStorageKey: storageKey },
        update: { profilePhotoStorageKey: storageKey },
      });
    }
    const user = await transaction.user.findUniqueOrThrow({
      where: { id: userId },
      select: authenticatedUserSelect,
    });
    return { user, previousKey: previous?.profilePhotoStorageKey ?? null };
  });
}
