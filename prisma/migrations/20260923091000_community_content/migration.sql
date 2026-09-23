CREATE TYPE "CommunityCommentStatus" AS ENUM ('ACTIVE', 'EDITED', 'REMOVED');

ALTER TABLE "community_posts" ADD COLUMN "edited_at" TIMESTAMPTZ(6);

CREATE TABLE "community_comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "status" "CommunityCommentStatus" NOT NULL DEFAULT 'ACTIVE',
    "edited_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "community_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "community_comments_post_id_status_created_at_idx"
ON "community_comments"("post_id", "status", "created_at");

CREATE INDEX "community_comments_author_id_status_created_at_idx"
ON "community_comments"("author_id", "status", "created_at");

ALTER TABLE "community_comments"
ADD CONSTRAINT "community_comments_post_id_fkey"
FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_comments"
ADD CONSTRAINT "community_comments_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports" ADD COLUMN "reported_community_post_id" UUID;
ALTER TABLE "reports" ADD COLUMN "reported_community_comment_id" UUID;

CREATE INDEX "reports_reported_community_post_id_idx"
ON "reports"("reported_community_post_id");

CREATE INDEX "reports_reported_community_comment_id_idx"
ON "reports"("reported_community_comment_id");

ALTER TABLE "reports"
ADD CONSTRAINT "reports_reported_community_post_id_fkey"
FOREIGN KEY ("reported_community_post_id") REFERENCES "community_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports"
ADD CONSTRAINT "reports_reported_community_comment_id_fkey"
FOREIGN KEY ("reported_community_comment_id") REFERENCES "community_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports" DROP CONSTRAINT "reports_one_target";

ALTER TABLE "reports" ADD CONSTRAINT "reports_one_target" CHECK (
  ("target_type" = 'USER' AND "reported_user_id" IS NOT NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'TRIP' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NOT NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'CONNECTION_REQUEST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NOT NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'MESSAGE' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NOT NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'COMMUNITY_POST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NOT NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'COMMUNITY_COMMENT' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "reports_open_community_post_target_key"
ON "reports"("reporter_id", "reported_community_post_id")
WHERE "reported_community_post_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');

CREATE UNIQUE INDEX "reports_open_community_comment_target_key"
ON "reports"("reporter_id", "reported_community_comment_id")
WHERE "reported_community_comment_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');
