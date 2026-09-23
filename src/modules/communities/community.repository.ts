import type { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import type {
  CommunityRepository,
  CommunitySummaryRecord,
} from './community.types.js';

const communitySelect = {
  id: true,
  slug: true,
  name: true,
  region: true,
  countryCode: true,
  description: true,
} satisfies Prisma.CommunitySelect;

type BaseCommunityRecord = Prisma.CommunityGetPayload<{
  select: typeof communitySelect;
}>;

const publicPostSelect = {
  id: true,
  communityId: true,
  type: true,
  title: true,
  body: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.CommunityPostSelect;

function visiblePostAuthor(viewerId?: string): Prisma.UserWhereInput {
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

function utcStartOfToday(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

async function addActivityCounts(
  communities: BaseCommunityRecord[],
): Promise<CommunitySummaryRecord[]> {
  const communityIds = communities.map((community) => community.id);
  if (communityIds.length === 0) return [];

  const [followers, trips, posts] = await database.$transaction([
    database.communityFollow.groupBy({
      by: ['communityId'],
      where: {
        communityId: { in: communityIds },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      _count: { _all: true },
    }),
    database.trip.groupBy({
      by: ['communityId'],
      where: {
        communityId: { in: communityIds },
        status: { in: ['PUBLISHED', 'FULL'] },
        endDate: { gte: utcStartOfToday() },
      },
      _count: { _all: true },
    }),
    database.communityPost.groupBy({
      by: ['communityId'],
      where: {
        communityId: { in: communityIds },
        status: 'PUBLISHED',
        removedAt: null,
        author: visiblePostAuthor(),
      },
      _count: { _all: true },
    }),
  ]);

  const followerCounts = new Map(
    followers.map((item) => [item.communityId, item._count._all]),
  );
  const tripCounts = new Map(
    trips.map((item) => [item.communityId, item._count._all]),
  );
  const postCounts = new Map(
    posts.map((item) => [item.communityId, item._count._all]),
  );

  return communities.map((community) => ({
    ...community,
    followerCount: followerCounts.get(community.id) ?? 0,
    upcomingTripCount: tripCounts.get(community.id) ?? 0,
    postCount: postCounts.get(community.id) ?? 0,
  }));
}

export const prismaCommunityRepository: CommunityRepository = {
  async listActive(query) {
    const where: Prisma.CommunityWhereInput = {
      status: 'ACTIVE',
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search, mode: 'insensitive' } },
          { region: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [communities, totalItems] = await database.$transaction([
      database.community.findMany({
        where,
        select: communitySelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.community.count({ where }),
    ]);
    return {
      communities: await addActivityCounts(communities),
      totalItems,
    };
  },

  async findActiveBySlug(slug) {
    const community = await database.community.findFirst({
      where: { slug, status: 'ACTIVE' },
      select: communitySelect,
    });
    if (!community) return null;
    return (await addActivityCounts([community]))[0] ?? null;
  },

  async listPublishedPosts(communityId, query) {
    const where: Prisma.CommunityPostWhereInput = {
      communityId,
      status: 'PUBLISHED',
      removedAt: null,
      ...(query.type && { type: query.type }),
      author: visiblePostAuthor(query.viewerId),
    };
    const [posts, totalItems] = await database.$transaction([
      database.communityPost.findMany({
        where,
        select: publicPostSelect,
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.communityPost.count({ where }),
    ]);
    return {
      posts: posts.flatMap((post) =>
        post.publishedAt ? [{ ...post, publishedAt: post.publishedAt }] : [],
      ),
      totalItems,
    };
  },

  follow(userId, communityId) {
    return database.$transaction(async (transaction) => {
      const community = await transaction.community.findFirst({
        where: { id: communityId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!community) return null;
      return transaction.communityFollow.upsert({
        where: { communityId_userId: { communityId, userId } },
        create: { communityId, userId },
        update: {},
      });
    });
  },

  unfollow(userId, communityId) {
    return database.$transaction(async (transaction) => {
      const community = await transaction.community.findFirst({
        where: { id: communityId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!community) return null;
      const result = await transaction.communityFollow.deleteMany({
        where: { communityId, userId },
      });
      return result.count > 0;
    });
  },

  async listFollowed(userId, query) {
    const where: Prisma.CommunityFollowWhereInput = {
      userId,
      community: { status: 'ACTIVE' },
    };
    const [follows, totalItems] = await database.$transaction([
      database.communityFollow.findMany({
        where,
        select: {
          followedAt: true,
          community: { select: communitySelect },
        },
        orderBy: [{ followedAt: 'desc' }, { communityId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.communityFollow.count({ where }),
    ]);
    const summaries = await addActivityCounts(
      follows.map((follow) => follow.community),
    );
    return {
      follows: follows.flatMap((follow, index) => {
        const community = summaries[index];
        return community ? [{ followedAt: follow.followedAt, community }] : [];
      }),
      totalItems,
    };
  },
};
