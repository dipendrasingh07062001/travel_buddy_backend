import { AppError } from '../../errors/app-error.js';
import type { TripRepository } from '../trips/trip.types.js';
import type {
  CommunityRepository,
  ListCommunitiesQuery,
  ListCommunityPostsQuery,
} from './community.types.js';

export async function requireActiveCommunity(
  slug: string,
  repository: CommunityRepository,
) {
  const community = await repository.findActiveBySlug(slug.toLowerCase());
  if (!community) {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
  }
  return community;
}

export function listCommunities(
  query: ListCommunitiesQuery,
  repository: CommunityRepository,
) {
  const search = query.search?.trim();
  return repository.listActive({
    page: query.page,
    pageSize: query.pageSize,
    ...(search && { search }),
  });
}

export async function listCommunityPosts(
  slug: string,
  query: ListCommunityPostsQuery,
  repository: CommunityRepository,
) {
  const community = await requireActiveCommunity(slug, repository);
  return repository.listPublishedPosts(community.id, query);
}

export async function listCommunityTrips(
  slug: string,
  query: Parameters<TripRepository['listPublic']>[0],
  repository: CommunityRepository,
  tripRepository: TripRepository,
) {
  const community = await requireActiveCommunity(slug, repository);
  return tripRepository.listPublic({ ...query, destination: community.slug });
}

export async function followCommunity(
  userId: string,
  communityId: string,
  repository: CommunityRepository,
) {
  const follow = await repository.follow(userId, communityId);
  if (!follow) {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
  }
  return follow;
}

export async function unfollowCommunity(
  userId: string,
  communityId: string,
  repository: CommunityRepository,
) {
  const result = await repository.unfollow(userId, communityId);
  if (result === null) {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Community not found.');
  }
}
