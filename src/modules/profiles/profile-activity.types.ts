import type { Prisma } from '../../generated/prisma/client.js';

export const activityCommunitySelect = {
  id: true,
  slug: true,
  name: true,
  region: true,
  countryCode: true,
} satisfies Prisma.CommunitySelect;

export const profileTripSelect = {
  id: true,
  originCity: true,
  startDate: true,
  endDate: true,
  dateMode: true,
  weekendsOnly: true,
  durationDays: true,
  status: true,
  publishedAt: true,
  community: { select: activityCommunitySelect },
} satisfies Prisma.TripSelect;

export const profilePostSelect = {
  id: true,
  type: true,
  title: true,
  publishedAt: true,
  community: { select: activityCommunitySelect },
} satisfies Prisma.CommunityPostSelect;

export const profileCommentSelect = {
  id: true,
  createdAt: true,
  editedAt: true,
  post: {
    select: {
      id: true,
      title: true,
      community: { select: activityCommunitySelect },
    },
  },
} satisfies Prisma.CommunityCommentSelect;

export type ProfileTripActivity = Prisma.TripGetPayload<{
  select: typeof profileTripSelect;
}>;
export type ProfilePostActivity = Prisma.CommunityPostGetPayload<{
  select: typeof profilePostSelect;
}>;
export type ProfileCommentActivity = Prisma.CommunityCommentGetPayload<{
  select: typeof profileCommentSelect;
}>;
export interface ActivityPage {
  page: number;
  pageSize: number;
}
export interface ProfileTripQuery extends ActivityPage {
  period: 'upcoming' | 'past';
}
export interface ActivityResult<T> {
  items: T[];
  totalItems: number;
}
export interface ProfileActivityRepository {
  listTrips(
    userId: string,
    viewerId: string | undefined,
    query: ProfileTripQuery,
  ): Promise<ActivityResult<ProfileTripActivity> | null>;
  listPosts(
    userId: string,
    viewerId: string | undefined,
    query: ActivityPage,
  ): Promise<ActivityResult<ProfilePostActivity> | null>;
  listComments(
    userId: string,
    viewerId: string | undefined,
    query: ActivityPage,
  ): Promise<ActivityResult<ProfileCommentActivity> | null>;
}
export interface ProfileActivityDependencies {
  repository: ProfileActivityRepository;
}
