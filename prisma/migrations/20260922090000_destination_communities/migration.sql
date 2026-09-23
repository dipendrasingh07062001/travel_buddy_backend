CREATE TYPE "CommunityPostType" AS ENUM ('DISCUSSION', 'QUESTION', 'EXPERIENCE');

CREATE TYPE "CommunityPostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'REMOVED');

CREATE TABLE "community_follows" (
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "followed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_follows_pkey" PRIMARY KEY ("community_id", "user_id")
);

CREATE TABLE "community_posts" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "type" "CommunityPostType" NOT NULL,
    "status" "CommunityPostStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "community_follows_user_id_followed_at_idx"
ON "community_follows"("user_id", "followed_at");

CREATE INDEX "community_posts_community_id_status_published_at_idx"
ON "community_posts"("community_id", "status", "published_at");

CREATE INDEX "community_posts_author_id_status_published_at_idx"
ON "community_posts"("author_id", "status", "published_at");

ALTER TABLE "community_follows"
ADD CONSTRAINT "community_follows_community_id_fkey"
FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_follows"
ADD CONSTRAINT "community_follows_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_posts"
ADD CONSTRAINT "community_posts_community_id_fkey"
FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_posts"
ADD CONSTRAINT "community_posts_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
