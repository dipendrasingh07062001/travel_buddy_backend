CREATE TYPE "StaffRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');
CREATE TYPE "ModerationActionType" AS ENUM (
    'REPORT_CLAIMED',
    'REPORT_DISMISSED',
    'USER_SUSPENDED',
    'USER_RESTORED',
    'CONTENT_REMOVED',
    'STAFF_ROLE_GRANTED',
    'STAFF_ROLE_REVOKED'
);

ALTER TABLE "users" ADD COLUMN "staff_role" "StaffRole" NOT NULL DEFAULT 'USER';
ALTER TABLE "trips" ADD COLUMN "moderation_removed_at" TIMESTAMPTZ(6);
ALTER TABLE "reports" ADD COLUMN "reviewer_id" UUID;
ALTER TABLE "reports" ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);
ALTER TABLE "reports" ADD COLUMN "resolved_at" TIMESTAMPTZ(6);

CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "report_id" UUID,
    "action" "ModerationActionType" NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reports_status_created_at_id_idx" ON "reports"("status", "created_at", "id");
CREATE INDEX "reports_reviewer_id_status_idx" ON "reports"("reviewer_id", "status");
CREATE INDEX "moderation_actions_report_id_created_at_idx" ON "moderation_actions"("report_id", "created_at");
CREATE INDEX "moderation_actions_target_type_target_id_created_at_idx" ON "moderation_actions"("target_type", "target_id", "created_at");
CREATE INDEX "moderation_actions_actor_id_created_at_idx" ON "moderation_actions"("actor_id", "created_at");

ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_fkey"
    FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
