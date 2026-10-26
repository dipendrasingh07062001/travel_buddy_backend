import type { CommunityPostType } from '../../generated/prisma/client.js';
import type { TripRepository } from '../trips/trip.types.js';

export interface CommunitySummaryRecord {
  id: string;
  slug: string;
  name: string;
  region: string | null;
  countryCode: string;
  description: string | null;
  followerCount: number;
  upcomingTripCount: number;
  postCount: number;
}

export interface CommunityPostRecord {
  id: string;
  communityId: string;
  type: CommunityPostType;
  title: string;
  body: string;
  author: {
    id: string;
    displayName: string | null;
  };
  community: Pick<
    CommunitySummaryRecord,
    'id' | 'slug' | 'name' | 'region' | 'countryCode'
  >;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityFollowRecord {
  communityId: string;
  userId: string;
  followedAt: Date;
}

export interface FollowedCommunityRecord {
  followedAt: Date;
  community: CommunitySummaryRecord;
}

export const communitySortValues = ['name', 'activity'] as const;
export type CommunitySort = (typeof communitySortValues)[number];

export interface ListCommunitiesQuery {
  search?: string;
  sort: CommunitySort;
  page: number;
  pageSize: number;
}

export interface ListCommunityPostsQuery {
  viewerId?: string;
  type?: CommunityPostType;
  page: number;
  pageSize: number;
}

export interface ListRecentCommunityPostsQuery extends ListCommunityPostsQuery {
  // Optional destination filter: a community slug (merged slugs resolve).
  community?: string;
}

export interface ListFollowedCommunitiesQuery {
  page: number;
  pageSize: number;
}

export interface CommunityRepository {
  listActive(
    query: ListCommunitiesQuery,
  ): Promise<{ communities: CommunitySummaryRecord[]; totalItems: number }>;
  findActiveBySlug(slug: string): Promise<CommunitySummaryRecord | null>;
  // A null community lists posts from every active community.
  listPublishedPosts(
    communityId: string | null,
    query: ListCommunityPostsQuery,
  ): Promise<{ posts: CommunityPostRecord[]; totalItems: number }>;
  follow(
    userId: string,
    communityId: string,
  ): Promise<CommunityFollowRecord | null>;
  unfollow(userId: string, communityId: string): Promise<boolean | null>;
  listFollowed(
    userId: string,
    query: ListFollowedCommunitiesQuery,
  ): Promise<{ follows: FollowedCommunityRecord[]; totalItems: number }>;
}

export interface CommunityRouteDependencies {
  repository: CommunityRepository;
  tripRepository: TripRepository;
}
