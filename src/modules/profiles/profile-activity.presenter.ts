import { publicText } from '../../privacy/public-text.js';
import { presentPublicDestination } from '../communities/community.presenter.js';
import type {
  ProfileTripActivity,
  ProfilePostActivity,
  ProfileCommentActivity,
} from './profile-activity.types.js';

export function presentProfileTrip(trip: ProfileTripActivity) {
  return {
    id: trip.id,
    originCity: publicText(trip.originCity),
    destination: presentPublicDestination(trip.community),
    startDate: trip.startDate.toISOString().slice(0, 10),
    endDate: trip.endDate.toISOString().slice(0, 10),
    dateMode: trip.dateMode,
    weekendsOnly: trip.weekendsOnly,
    durationDays: trip.durationDays,
    status: trip.status,
    publishedAt: trip.publishedAt?.toISOString() ?? null,
  };
}
export function presentProfilePost(post: ProfilePostActivity) {
  return {
    id: post.id,
    type: post.type,
    title: publicText(post.title),
    community: presentPublicDestination(post.community),
    publishedAt: post.publishedAt?.toISOString() ?? null,
  };
}
export function presentProfileComment(comment: ProfileCommentActivity) {
  return {
    id: comment.id,
    post: { id: comment.post.id, title: publicText(comment.post.title) },
    community: presentPublicDestination(comment.post.community),
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
  };
}
