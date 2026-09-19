-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('USER', 'TRIP', 'CONNECTION_REQUEST');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('HARASSMENT', 'HATE_OR_THREATS', 'SEXUAL_SOLICITATION', 'SCAM_OR_FRAUD', 'IMPERSONATION', 'COMMERCIAL_TOUR_SPAM', 'PRIVACY_VIOLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'ACTIONED', 'DISMISSED');

-- CreateTable
CREATE TABLE "user_blocks" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id","blocked_id"),
    CONSTRAINT "user_blocks_not_self" CHECK ("blocker_id" <> "blocked_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "reported_user_id" UUID,
    "reported_trip_id" UUID,
    "reported_connection_request_id" UUID,
    "reason" "ReportReason" NOT NULL,
    "details" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reports_one_target" CHECK (
      ("target_type" = 'USER' AND "reported_user_id" IS NOT NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL)
      OR ("target_type" = 'TRIP' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NOT NULL AND "reported_connection_request_id" IS NULL)
      OR ("target_type" = 'CONNECTION_REQUEST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks"("blocked_id");
CREATE INDEX "reports_reporter_id_status_created_at_idx" ON "reports"("reporter_id", "status", "created_at");
CREATE INDEX "reports_reported_user_id_idx" ON "reports"("reported_user_id");
CREATE INDEX "reports_reported_trip_id_idx" ON "reports"("reported_trip_id");
CREATE INDEX "reports_reported_connection_request_id_idx" ON "reports"("reported_connection_request_id");

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_trip_id_fkey" FOREIGN KEY ("reported_trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_connection_request_id_fkey" FOREIGN KEY ("reported_connection_request_id") REFERENCES "connection_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
