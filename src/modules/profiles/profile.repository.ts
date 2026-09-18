import type { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import { authenticatedUserSelect } from '../auth/auth.repository.js';
import type { ProfileRepository } from './profile.types.js';

export const prismaProfileRepository: ProfileRepository = {
  async update(userId, input) {
    return database.$transaction(async (transaction) => {
      const userData: Prisma.UserUpdateInput = {};
      if (input.displayName !== undefined) {
        userData.displayName = input.displayName;
      }
      if (input.birthDate !== undefined) {
        userData.birthDate = input.birthDate;
      }
      if (Object.keys(userData).length > 0) {
        await transaction.user.update({
          where: { id: userId },
          data: userData,
        });
      }

      const profileData = {
        ...(input.homeCity !== undefined && { homeCity: input.homeCity }),
        ...(input.homeRegion !== undefined && {
          homeRegion: input.homeRegion,
        }),
        ...(input.biography !== undefined && { biography: input.biography }),
        ...(input.languages !== undefined && { languages: input.languages }),
        ...(input.travelInterests !== undefined && {
          travelInterests: input.travelInterests,
        }),
        ...(input.pastTripsVisibility !== undefined && {
          pastTripsVisibility: input.pastTripsVisibility,
        }),
        ...(input.communityActivityVisibility !== undefined && {
          communityActivityVisibility: input.communityActivityVisibility,
        }),
      } satisfies Prisma.UserProfileUncheckedUpdateInput;
      if (Object.keys(profileData).length > 0) {
        await transaction.userProfile.upsert({
          where: { userId },
          create: { userId, ...profileData },
          update: profileData,
        });
      }

      return transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: authenticatedUserSelect,
      });
    });
  },

  findPublicByUserId(userId) {
    return database.user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
      select: authenticatedUserSelect,
    });
  },
};
