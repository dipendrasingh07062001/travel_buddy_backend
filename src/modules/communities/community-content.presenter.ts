import type {
  CommunityCommentRecord,
  CommunityContentPostRecord,
} from './community-content.types.js';

export function presentCommunityContentPost(post: CommunityContentPostRecord) {
  return {
    id: post.id,
    communityId: post.communityId,
    type: post.type,
    title: post.title,
    body: post.body,
    author: post.author,
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
    body: comment.body,
    status: comment.status,
    author: comment.author,
    editedAt: comment.editedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}
