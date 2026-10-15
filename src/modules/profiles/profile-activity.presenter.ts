import type {
  ProfileTripActivity,
  ProfilePostActivity,
  ProfileCommentActivity,
} from './profile-activity.types.js';

export function presentProfileTrip(trip: ProfileTripActivity) {
  return {
    id: trip.id,
    originCity: trip.originCity,
    destination: trip.community,
    startDate: trip.startDate.toISOString().slice(0, 10),
    endDate: trip.endDate.toISOString().slice(0, 10),
    durationDays: trip.durationDays,
    status: trip.status,
    publishedAt: trip.publishedAt?.toISOString() ?? null,
  };
}
export function presentProfilePost(post: ProfilePostActivity) {
  return {
    id: post.id,
    type: post.type,
    title: post.title,
    community: post.community,
    publishedAt: post.publishedAt?.toISOString() ?? null,
  };
}
export function presentProfileComment(comment: ProfileCommentActivity) {
  return {
    id: comment.id,
    post: { id: comment.post.id, title: comment.post.title },
    community: comment.post.community,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
  };
}
