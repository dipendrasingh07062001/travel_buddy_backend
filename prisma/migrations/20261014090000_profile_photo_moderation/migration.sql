ALTER TYPE "NotificationType" ADD VALUE 'PROFILE_PHOTO_REMOVED';

ALTER TYPE "ReportTargetType" ADD VALUE 'PROFILE_PHOTO';

-- The photo a PROFILE_PHOTO report refers to, and a private copy kept as
-- evidence in case the user replaces it before staff review.
ALTER TABLE "reports"
    ADD COLUMN "reported_photo_key" VARCHAR(500),
    ADD COLUMN "evidence_storage_key" VARCHAR(500);

-- A private copy of a profile photo that staff removed without a report.
ALTER TABLE "moderation_actions" ADD COLUMN "evidence_storage_key" VARCHAR(500);

-- Profile-photo reports also use reported_user_id, so one open report per
-- reporter and user now applies per target type: a person and their photo
-- can be reported separately.
DROP INDEX "reports_open_user_target_key";
CREATE UNIQUE INDEX "reports_open_user_target_key"
ON "reports"("reporter_id", "target_type", "reported_user_id")
WHERE "reported_user_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');
