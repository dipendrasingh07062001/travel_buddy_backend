CREATE TYPE "EmailCategory" AS ENUM ('CONNECTIONS', 'TRIPS', 'FINANCES', 'SAFETY');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

CREATE TABLE "email_preferences" (
    "user_id" UUID NOT NULL,
    "connections" BOOLEAN NOT NULL DEFAULT false,
    "trips" BOOLEAN NOT NULL DEFAULT false,
    "finances" BOOLEAN NOT NULL DEFAULT false,
    "safety" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "email_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "email_preferences_version_positive" CHECK ("version" > 0)
);
ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "category" "EmailCategory" NOT NULL,
    "preference_version" INTEGER NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_deliveries_attempts_nonnegative" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "email_deliveries_notification_id_key" ON "email_deliveries"("notification_id");
CREATE INDEX "email_deliveries_status_next_attempt_at_created_at_idx" ON "email_deliveries"("status", "next_attempt_at", "created_at");
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
