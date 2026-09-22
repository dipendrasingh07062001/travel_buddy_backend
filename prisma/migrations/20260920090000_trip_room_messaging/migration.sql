-- Extend report targets without relying on an enum value before transaction commit.
ALTER TABLE "reports" DROP CONSTRAINT "reports_one_target";
CREATE TYPE "ReportTargetType_new" AS ENUM ('USER', 'TRIP', 'CONNECTION_REQUEST', 'MESSAGE');
ALTER TABLE "reports"
  ALTER COLUMN "target_type" TYPE "ReportTargetType_new"
  USING ("target_type"::text::"ReportTargetType_new");
DROP TYPE "ReportTargetType";
ALTER TYPE "ReportTargetType_new" RENAME TO "ReportTargetType";

CREATE TYPE "MessageStatus" AS ENUM ('ACTIVE', 'EDITED', 'DELETED');
CREATE TYPE "MessageRevisionAction" AS ENUM ('EDIT', 'DELETE');

CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_participants" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(6),
    "muted_at" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id", "user_id")
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'ACTIVE',
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_revisions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "editor_id" UUID NOT NULL,
    "action" "MessageRevisionAction" NOT NULL,
    "previous_body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversations_trip_id_key" ON "conversations"("trip_id");
CREATE INDEX "conversation_participants_user_id_idx" ON "conversation_participants"("user_id");
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");
CREATE INDEX "messages_sender_id_created_at_idx" ON "messages"("sender_id", "created_at");
CREATE INDEX "message_revisions_message_id_created_at_idx" ON "message_revisions"("message_id", "created_at");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill one private conversation and participant state for every existing trip.
INSERT INTO "conversations" ("id", "trip_id", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", "created_at", CURRENT_TIMESTAMP FROM "trips";

INSERT INTO "conversation_participants" ("conversation_id", "user_id", "joined_at")
SELECT c."id", tm."user_id", tm."joined_at"
FROM "trip_memberships" tm
JOIN "conversations" c ON c."trip_id" = tm."trip_id";

ALTER TABLE "reports" ADD COLUMN "reported_message_id" UUID;
CREATE INDEX "reports_reported_message_id_idx" ON "reports"("reported_message_id");
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_message_id_fkey" FOREIGN KEY ("reported_message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports" ADD CONSTRAINT "reports_one_target" CHECK (
  ("target_type" = 'USER' AND "reported_user_id" IS NOT NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL)
  OR ("target_type" = 'TRIP' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NOT NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL)
  OR ("target_type" = 'CONNECTION_REQUEST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NOT NULL AND "reported_message_id" IS NULL)
  OR ("target_type" = 'MESSAGE' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "reports_open_message_target_key"
ON "reports"("reporter_id", "reported_message_id")
WHERE "reported_message_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');
