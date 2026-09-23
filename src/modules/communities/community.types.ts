import type { CommunityPostType } from '@prisma/client';

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

export interface ListCommunitiesQuery {
  search?: string;
  page: number;
  pageSize: number;
}

export interface ListCommunityPostsQuery {
  viewerId?: string;
  type?: CommunityPostType;
  page: number;
  pageSize: number;
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
  listPublishedPosts(
    communityId: string,
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
