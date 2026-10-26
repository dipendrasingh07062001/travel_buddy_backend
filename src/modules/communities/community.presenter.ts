import { publicText } from '../../privacy/public-text.js';
import type {
  CommunityPostRecord,
  CommunitySummaryRecord,
  FollowedCommunityRecord,
} from './community.types.js';

export function presentPublicDestination(
  community: Pick<
    CommunitySummaryRecord,
    'id' | 'slug' | 'name' | 'region' | 'countryCode'
  >,
) {
  return {
    id: community.id,
    slug: community.slug,
    name: publicText(community.name),
    region: publicText(community.region),
    countryCode: community.countryCode.trim(),
  };
}

export function presentCommunity(community: CommunitySummaryRecord) {
  return {
    id: community.id,
    slug: community.slug,
    name: publicText(community.name),
    region: publicText(community.region),
    countryCode: community.countryCode.trim(),
    description: publicText(community.description),
    activity: {
      followers: community.followerCount,
      upcomingTrips: community.upcomingTripCount,
      posts: community.postCount,
    },
  };
}

export function presentCommunityPost(post: CommunityPostRecord) {
  return {
    id: post.id,
    communityId: post.communityId,
    type: post.type,
    title: publicText(post.title),
    body: publicText(post.body),
    author: {
      id: post.author.id,
      displayName: publicText(post.author.displayName),
    },
    publishedAt: post.publishedAt.toISOString(),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

// Cross-community lists name the destination so a card can show its source.
export function presentRecentCommunityPost(post: CommunityPostRecord) {
  return {
    ...presentCommunityPost(post),
    community: presentPublicDestination(post.community),
  };
}

export function presentFollowedCommunity(follow: FollowedCommunityRecord) {
  return {
    followedAt: follow.followedAt.toISOString(),
    community: presentCommunity(follow.community),
  };
}
