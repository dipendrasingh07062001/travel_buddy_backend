CREATE TYPE "TripChangeAction" AS ENUM ('CREATED', 'OWNER_UPDATED', 'STATUS_CHANGED', 'MEMBER_JOINED', 'MEMBER_LEFT', 'MEMBER_REMOVED', 'COMMUNITY_MERGED', 'MODERATION_REMOVED', 'ACCOUNT_ERASURE');

ALTER TABLE "trip_memberships" ADD COLUMN "history_from_version" INTEGER;
-- Existing members start at the next recorded change; do not reconstruct history.
UPDATE "trip_memberships" AS m
SET "history_from_version" = t."version" + 1
FROM "trips" AS t
WHERE m."trip_id" = t."id" AND m."role" = 'MEMBER' AND m."status" = 'ACTIVE';

CREATE TABLE "trip_changes" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "actor_id" UUID,
    "action" "TripChangeAction" NOT NULL,
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trip_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trip_changes_trip_id_version_key" ON "trip_changes"("trip_id", "version");
CREATE INDEX "trip_changes_actor_id_idx" ON "trip_changes"("actor_id");
ALTER TABLE "trip_changes" ADD CONSTRAINT "trip_changes_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_changes" ADD CONSTRAINT "trip_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
