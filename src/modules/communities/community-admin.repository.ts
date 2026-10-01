import { Prisma, type CommunityStatus } from '@prisma/client';

import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';

export interface CommunityMetadata {
  name: string;
  region: string | null;
  countryCode: string;
  description: string | null;
}

export type CommunityMetadataPatch = Partial<CommunityMetadata>;

const adminCommunityInclude = {
  _count: {
    select: { trips: true, posts: true, followers: true, mergedFrom: true },
  },
} satisfies Prisma.CommunityInclude;

function stateConflict(): AppError {
  return new AppError(
    409,
    'COMMUNITY_VERSION_CONFLICT',
    'The community changed. Refresh it before trying again.',
  );
}

function requireCommunity<T>(community: T | null): T {
  if (!community)
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
  return community;
}

export async function listAdminCommunities(
  status: CommunityStatus | undefined,
  search: string | undefined,
  page: number,
  pageSize: number,
) {
  const where: Prisma.CommunityWhereInput = {
    ...(status && { status }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { region: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };
  const [communities, totalItems] = await database.$transaction([
    database.community.findMany({
      where,
      include: adminCommunityInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.community.count({ where }),
  ]);
  return { communities, totalItems };
}

export async function findAdminCommunity(id: string) {
  return requireCommunity(
    await database.community.findUnique({
      where: { id },
      include: adminCommunityInclude,
    }),
  );
}

export async function createAdminCommunity(
  actorId: string,
  slug: string,
  metadata: CommunityMetadata,
) {
  try {
    return await database.$transaction(async (transaction) => {
      const community = await transaction.community.create({
        data: { slug, ...metadata },
        include: adminCommunityInclude,
      });
      await transaction.communityAdminAction.create({
        data: {
          actorId,
          communityId: community.id,
          action: 'CREATED',
          reason: 'Administrator created a destination community.',
          details: { slug, ...metadata },
        },
      });
      return community;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AppError(
        409,
        'COMMUNITY_SLUG_TAKEN',
        'A community already uses this slug.',
      );
    }
    throw error;
  }
}

export async function updateAdminCommunity(
  actorId: string,
  id: string,
  expectedVersion: number,
  metadata: CommunityMetadataPatch,
  reason: string,
) {
  return database.$transaction(async (transaction) => {
    const before = requireCommunity(
      await transaction.community.findUnique({ where: { id } }),
    );
    if (before.status !== 'ACTIVE' || before.version !== expectedVersion)
      throw stateConflict();
    const changed = await transaction.community.updateMany({
      where: { id, status: 'ACTIVE', version: expectedVersion },
      data: { ...metadata, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw stateConflict();
    const after = await transaction.community.findUniqueOrThrow({
      where: { id },
      include: adminCommunityInclude,
    });
    await transaction.communityAdminAction.create({
      data: {
        actorId,
        communityId: id,
        action: 'UPDATED',
        reason,
        details: {
          before: {
            name: before.name,
            region: before.region,
            countryCode: before.countryCode,
            description: before.description,
          },
          after: metadata,
        },
      },
    });
    return after;
  });
}

export async function changeCommunityStatus(
  actorId: string,
  id: string,
  expectedVersion: number,
  targetStatus: 'ACTIVE' | 'ARCHIVED',
  reason: string,
) {
  return database.$transaction(async (transaction) => {
    // FOR UPDATE serializes status changes with new trips, follows, posts, and
    // duplicate merges. New content takes a shared lock on the same row.
    await transaction.$queryRaw`
      SELECT id FROM communities WHERE id = ${id}::uuid FOR UPDATE
    `;
    const before = requireCommunity(
      await transaction.community.findUnique({
        where: { id },
        include: adminCommunityInclude,
      }),
    );
    if (before.version !== expectedVersion || before.status === targetStatus)
      throw stateConflict();
    if (targetStatus === 'ACTIVE' && before.mergedIntoId) {
      throw new AppError(
        409,
        'COMMUNITY_ALREADY_MERGED',
        'A merged community cannot be reactivated.',
      );
    }
    if (
      targetStatus === 'ARCHIVED' &&
      (before._count.trips > 0 ||
        before._count.posts > 0 ||
        before._count.followers > 0 ||
        before._count.mergedFrom > 0)
    ) {
      throw new AppError(
        409,
        'COMMUNITY_NOT_EMPTY',
        'Merge or relocate content and followers before archiving this community.',
      );
    }
    const after = await transaction.community.update({
      where: { id },
      data: { status: targetStatus, version: { increment: 1 } },
      include: adminCommunityInclude,
    });
    await transaction.communityAdminAction.create({
      data: {
        actorId,
        communityId: id,
        action: targetStatus === 'ACTIVE' ? 'REACTIVATED' : 'ARCHIVED',
        reason,
        details: { previousStatus: before.status, newStatus: targetStatus },
      },
    });
    return after;
  });
}

export async function mergeAdminCommunities(
  actorId: string,
  sourceId: string,
  targetId: string,
  expectedSourceVersion: number,
  expectedTargetVersion: number,
  reason: string,
) {
  if (sourceId === targetId) {
    throw new AppError(
      400,
      'SAME_COMMUNITY',
      'Source and target must be different communities.',
    );
  }
  return database.$transaction(
    async (transaction) => {
      // Consistent lock order avoids a deadlock when two admins merge at once.
      await transaction.$queryRaw`
        SELECT id FROM communities
        WHERE id IN (${sourceId}::uuid, ${targetId}::uuid)
        ORDER BY id FOR UPDATE
      `;
      const [foundSource, foundTarget] = await Promise.all([
        transaction.community.findUnique({ where: { id: sourceId } }),
        transaction.community.findUnique({ where: { id: targetId } }),
      ]);
      const source = requireCommunity(foundSource);
      const target = requireCommunity(foundTarget);
      if (
        source.status !== 'ACTIVE' ||
        target.status !== 'ACTIVE' ||
        source.version !== expectedSourceVersion ||
        target.version !== expectedTargetVersion
      ) {
        throw stateConflict();
      }

      const targetFollowersBefore = await transaction.communityFollow.count({
        where: { communityId: targetId },
      });
      const sourceFollowers = await transaction.communityFollow.count({
        where: { communityId: sourceId },
      });
      // Keep the earliest follow timestamp when a user follows both hubs.
      await transaction.$executeRaw`
        INSERT INTO community_follows (community_id, user_id, followed_at)
        SELECT ${targetId}::uuid, user_id, followed_at
        FROM community_follows WHERE community_id = ${sourceId}::uuid
        ON CONFLICT (community_id, user_id) DO UPDATE
        SET followed_at = LEAST(community_follows.followed_at, EXCLUDED.followed_at)
      `;
      await transaction.communityFollow.deleteMany({
        where: { communityId: sourceId },
      });
      const targetFollowersAfter = await transaction.communityFollow.count({
        where: { communityId: targetId },
      });
      const trips = await transaction.trip.updateMany({
        where: { communityId: sourceId },
        data: { communityId: targetId },
      });
      const posts = await transaction.communityPost.updateMany({
        where: { communityId: sourceId },
        data: { communityId: targetId },
      });
      const aliases = await transaction.community.updateMany({
        where: { mergedIntoId: sourceId },
        data: { mergedIntoId: targetId, version: { increment: 1 } },
      });
      await transaction.community.update({
        where: { id: sourceId },
        data: {
          status: 'ARCHIVED',
          mergedIntoId: targetId,
          version: { increment: 1 },
        },
      });
      const canonical = await transaction.community.update({
        where: { id: targetId },
        data: { version: { increment: 1 } },
        include: adminCommunityInclude,
      });
      await transaction.communityAdminAction.create({
        data: {
          actorId,
          communityId: sourceId,
          targetCommunityId: targetId,
          action: 'MERGED',
          reason,
          details: {
            tripsMoved: trips.count,
            postsMoved: posts.count,
            followersMoved: sourceFollowers,
            duplicateFollows:
              sourceFollowers - (targetFollowersAfter - targetFollowersBefore),
            aliasesRedirected: aliases.count,
          },
        },
      });
      return canonical;
    },
    { timeout: 30_000 },
  );
}

export async function listCommunityAdminActions(
  communityId: string | undefined,
  page: number,
  pageSize: number,
) {
  const where: Prisma.CommunityAdminActionWhereInput = communityId
    ? { communityId }
    : {};
  const [actions, totalItems] = await database.$transaction([
    database.communityAdminAction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.communityAdminAction.count({ where }),
  ]);
  return { actions, totalItems };
}
