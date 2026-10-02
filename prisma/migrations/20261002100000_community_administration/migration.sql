CREATE TYPE "CommunityAdminActionType" AS ENUM (
    'CREATED', 'UPDATED', 'ARCHIVED', 'REACTIVATED', 'MERGED'
);

ALTER TABLE "communities"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "merged_into_id" UUID;

ALTER TABLE "communities"
    ADD CONSTRAINT "communities_merged_into_id_fkey"
    FOREIGN KEY ("merged_into_id") REFERENCES "communities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "communities_merged_into_id_idx"
    ON "communities"("merged_into_id");

CREATE TABLE "community_admin_actions" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "target_community_id" UUID,
    "action" "CommunityAdminActionType" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_admin_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "community_admin_actions_community_id_created_at_idx"
    ON "community_admin_actions"("community_id", "created_at");
CREATE INDEX "community_admin_actions_actor_id_created_at_idx"
    ON "community_admin_actions"("actor_id", "created_at");

ALTER TABLE "community_admin_actions"
    ADD CONSTRAINT "community_admin_actions_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_admin_actions"
    ADD CONSTRAINT "community_admin_actions_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_admin_actions"
    ADD CONSTRAINT "community_admin_actions_target_community_id_fkey"
    FOREIGN KEY ("target_community_id") REFERENCES "communities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
