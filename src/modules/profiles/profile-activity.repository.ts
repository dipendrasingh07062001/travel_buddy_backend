import type { Prisma } from '../../generated/prisma/client.js';
import { utcStartOfToday } from '../trips/trip.types.js';
import { withVisibleProfile } from './profile-visibility.js';
import {
  profileTripSelect,
  profilePostSelect,
  profileCommentSelect,
  type ProfileActivityRepository,
} from './profile-activity.types.js';

const empty = () => ({ items: [], totalItems: 0 });

// Mirrors public community-content author visibility. Following a community
// does not grant access to somebody else's non-public contributions.
function visibleParentAuthor(viewerId?: string): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    deletedAt: null,
    OR: [
      { profile: null },
      { profile: { communityActivityVisibility: 'PUBLIC' } },
    ],
    ...(viewerId && {
      blocksCreated: { none: { blockedId: viewerId } },
      blocksReceived: { none: { blockerId: viewerId } },
    }),
  };
}

export const prismaProfileActivityRepository: ProfileActivityRepository = {
  listTrips(userId, viewerId, query) {
    return withVisibleProfile(userId, viewerId, async (tx, profile) => {
      const past = query.period === 'past';
      const visibility = profile.profile?.pastTripsVisibility ?? 'MEMBERS_ONLY';
      if (
        past &&
        (visibility === 'PRIVATE' ||
          (visibility === 'MEMBERS_ONLY' && !viewerId))
      )
        return empty();
      const where: Prisma.TripWhereInput = {
        // Only authored trips are profile activity. A public profile is not
        // permission to disclose private joined-trip participation.
        ownerId: userId,
        moderationRemovedAt: null,
        community: { status: 'ACTIVE' },
        publishedAt: { not: null },
        ...(past
          ? {
              status: 'COMPLETED',
              ...(visibility === 'MEMBERS_ONLY' && {
                memberships: { some: { userId: viewerId!, status: 'ACTIVE' } },
              }),
            }
          : {
              status: { in: ['PUBLISHED', 'FULL'] },
              endDate: { gte: utcStartOfToday() },
            }),
      };
      const totalItems = await tx.trip.count({ where });
      const items = await tx.trip.findMany({
        where,
        select: profileTripSelect,
        orderBy: [{ startDate: past ? 'desc' : 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      return { items, totalItems };
    });
  },
  listPosts(userId, viewerId, query) {
    return withVisibleProfile(userId, viewerId, async (tx, profile) => {
      if (
        profile.profile &&
        profile.profile.communityActivityVisibility !== 'PUBLIC'
      )
        return empty();
      const where: Prisma.CommunityPostWhereInput = {
        authorId: userId,
        status: 'PUBLISHED',
        removedAt: null,
        publishedAt: { not: null },
        community: { status: 'ACTIVE' },
      };
      const totalItems = await tx.communityPost.count({ where });
      const items = await tx.communityPost.findMany({
        where,
        select: profilePostSelect,
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      return { items, totalItems };
    });
  },
  listComments(userId, viewerId, query) {
    return withVisibleProfile(userId, viewerId, async (tx, profile) => {
      if (
        profile.profile &&
        profile.profile.communityActivityVisibility !== 'PUBLIC'
      )
        return empty();
      const where: Prisma.CommunityCommentWhereInput = {
        authorId: userId,
        status: { in: ['ACTIVE', 'EDITED'] },
        removedAt: null,
        post: {
          status: 'PUBLISHED',
          removedAt: null,
          publishedAt: { not: null },
          community: { status: 'ACTIVE' },
          author: visibleParentAuthor(viewerId),
        },
      };
      const totalItems = await tx.communityComment.count({ where });
      const items = await tx.communityComment.findMany({
        where,
        select: profileCommentSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      return { items, totalItems };
    });
  },
};
