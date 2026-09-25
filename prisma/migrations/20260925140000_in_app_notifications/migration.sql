CREATE TYPE "NotificationType" AS ENUM (
    'CONNECTION_REQUEST_RECEIVED',
    'CONNECTION_REQUEST_ACCEPTED',
    'CONNECTION_REQUEST_DECLINED',
    'CONNECTION_REQUEST_WITHDRAWN',
    'TRIP_UPDATED',
    'TRIP_STATUS_CHANGED',
    'MESSAGE_RECEIVED',
    'EXPENSE_CREATED',
    'EXPENSE_UPDATED',
    'EXPENSE_VOIDED',
    'SETTLEMENT_PENDING',
    'SETTLEMENT_CONFIRMED',
    'SETTLEMENT_REJECTED',
    'SETTLEMENT_CANCELLED'
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "event_key" VARCHAR(150) NOT NULL,
    "source_id" UUID NOT NULL,
    "trip_id" UUID,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_recipient_id_event_key_key" ON "notifications"("recipient_id", "event_key");
CREATE INDEX "notifications_recipient_id_created_at_id_idx" ON "notifications"("recipient_id", "created_at", "id");
CREATE INDEX "notifications_recipient_id_read_at_idx" ON "notifications"("recipient_id", "read_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
