-- CreateEnum
CREATE TYPE "RestrictedFeature" AS ENUM ('CONNECTION_REQUESTS', 'COMMUNITY_POSTING', 'TRIP_PUBLISHING', 'MESSAGING');

-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'FEATURE_RESTRICTED';
ALTER TYPE "ModerationActionType" ADD VALUE 'FEATURE_RESTRICTION_LIFTED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FEATURE_RESTRICTED';
ALTER TYPE "NotificationType" ADD VALUE 'FEATURE_RESTRICTION_LIFTED';

-- CreateTable
CREATE TABLE "account_restrictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "feature" "RestrictedFeature" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "report_id" UUID,
    "created_by_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "lifted_at" TIMESTAMPTZ(6),
    "lifted_by_id" UUID,
    "lift_reason" VARCHAR(1000),

    CONSTRAINT "account_restrictions_pkey" PRIMARY KEY ("id"),
    -- A timed restriction lasts more than zero and at most 90 days.
    CONSTRAINT "account_restrictions_duration_check" CHECK (
        "ends_at" IS NULL
        OR ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + INTERVAL '90 days')
    ),
    -- Lifting always records who lifted it, why and when.
    CONSTRAINT "account_restrictions_lift_check" CHECK (
        ("lifted_at" IS NULL AND "lifted_by_id" IS NULL AND "lift_reason" IS NULL)
        OR (
            "lifted_at" IS NOT NULL
            AND "lifted_by_id" IS NOT NULL
            AND "lift_reason" IS NOT NULL
            AND "lifted_at" >= "starts_at"
        )
    )
);

-- CreateIndex
CREATE INDEX "account_restrictions_user_id_feature_lifted_at_idx" ON "account_restrictions"("user_id", "feature", "lifted_at");

-- CreateIndex
CREATE INDEX "account_restrictions_report_id_idx" ON "account_restrictions"("report_id");

-- AddForeignKey
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_lifted_by_id_fkey" FOREIGN KEY ("lifted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
