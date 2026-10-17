import { publicText } from '../../privacy/public-text.js';
import type {
  CommunityCommentRecord,
  CommunityContentPostRecord,
} from './community-content.types.js';

export function presentCommunityContentPost(post: CommunityContentPostRecord) {
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
    editedAt: post.editedAt?.toISOString() ?? null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function presentCommunityComment(comment: CommunityCommentRecord) {
  return {
    id: comment.id,
    postId: comment.postId,
    body: publicText(comment.body),
    status: comment.status,
    author: {
      id: comment.author.id,
      displayName: publicText(comment.author.displayName),
    },
    editedAt: comment.editedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}
