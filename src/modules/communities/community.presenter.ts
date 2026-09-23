import type {
  CommunityPostRecord,
  CommunitySummaryRecord,
  FollowedCommunityRecord,
} from './community.types.js';

export function presentCommunity(community: CommunitySummaryRecord) {
  return {
    id: community.id,
    slug: community.slug,
    name: community.name,
    region: community.region,
    countryCode: community.countryCode.trim(),
    description: community.description,
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
    title: post.title,
    body: post.body,
    author: post.author,
    publishedAt: post.publishedAt.toISOString(),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function presentFollowedCommunity(follow: FollowedCommunityRecord) {
  return {
    followedAt: follow.followedAt.toISOString(),
    community: presentCommunity(follow.community),
  };
}
