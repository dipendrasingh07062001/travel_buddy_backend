-- A deletion request locks the account for a grace period, then erases it.
-- The status to restore if the user cancels is kept while it waits.
ALTER TABLE "users"
    ADD COLUMN "status_before_deletion" "UserStatus",
    ADD COLUMN "records_purged_at" TIMESTAMPTZ(6);

ALTER TABLE "users" ADD CONSTRAINT "users_pending_deletion_state" CHECK (
    ("status" = 'PENDING_DELETION') = ("status_before_deletion" IS NOT NULL)
    AND "status_before_deletion" IN ('ACTIVE', 'SUSPENDED')
);

-- Deleted accounts whose moderation records are still kept.
CREATE INDEX "users_records_purge_due_idx"
    ON "users"("deleted_at") WHERE "status" = 'DELETED' AND "records_purged_at" IS NULL;

ALTER TABLE "account_data_requests"
    ADD COLUMN "scheduled_for" TIMESTAMPTZ(6),
    ADD COLUMN "completed_at" TIMESTAMPTZ(6);

ALTER TABLE "account_data_requests" ADD CONSTRAINT "account_data_requests_status_dates" CHECK (
    ("status" = 'OPEN' AND "cancelled_at" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "cancelled_at" IS NULL AND "completed_at" IS NOT NULL)
);

-- Only deletion requests are scheduled.
ALTER TABLE "account_data_requests" ADD CONSTRAINT "account_data_requests_schedule_type" CHECK (
    "scheduled_for" IS NULL OR "type" = 'ACCOUNT_DELETION'
);

CREATE INDEX "account_data_requests_deletion_due_idx"
    ON "account_data_requests"("scheduled_for") WHERE "status" = 'OPEN';
