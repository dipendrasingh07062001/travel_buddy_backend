CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

-- Notifications created before push delivery existed are never sent as push
-- alerts. New rows default to PENDING.
ALTER TABLE "notifications"
    ADD COLUMN "push_status" "PushDeliveryStatus" NOT NULL DEFAULT 'SKIPPED',
    ADD COLUMN "pushed_at" TIMESTAMPTZ(6);
ALTER TABLE "notifications" ALTER COLUMN "push_status" SET DEFAULT 'PENDING';

-- The delivery worker only scans undelivered rows.
CREATE INDEX "notifications_push_pending_created_at_idx"
    ON "notifications"("created_at", "id") WHERE "push_status" = 'PENDING';

CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");
CREATE INDEX "push_devices_user_id_updated_at_idx" ON "push_devices"("user_id", "updated_at");

ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
