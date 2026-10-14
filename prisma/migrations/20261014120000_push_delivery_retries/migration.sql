-- Failed push alerts are retried a few times, and alerts left SENDING by a
-- worker that crashed are picked up again.
ALTER TABLE "notifications"
    ADD COLUMN "push_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "push_next_attempt_at" TIMESTAMPTZ(6),
    ADD COLUMN "push_claimed_at" TIMESTAMPTZ(6);

-- Rows already stuck in SENDING are treated as claimed now, so the worker
-- recovers them (or skips them as too old) after the usual timeout.
UPDATE "notifications"
SET "push_claimed_at" = CURRENT_TIMESTAMP, "push_attempts" = 1
WHERE "push_status" = 'SENDING';

CREATE INDEX "notifications_push_sending_claimed_at_idx"
    ON "notifications"("push_claimed_at") WHERE "push_status" = 'SENDING';
