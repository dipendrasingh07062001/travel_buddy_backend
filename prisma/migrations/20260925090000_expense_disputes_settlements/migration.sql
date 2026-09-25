CREATE TYPE "ExpenseDisputeStatus" AS ENUM ('OPEN', 'WITHDRAWN');
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED');

CREATE TABLE "expense_disputes" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ExpenseDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "expense_disputes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_disputes_reason_nonblank" CHECK (length(btrim("reason")) >= 2),
    CONSTRAINT "expense_disputes_withdrawal_state" CHECK (("status" = 'OPEN' AND "withdrawn_at" IS NULL) OR ("status" = 'WITHDRAWN' AND "withdrawn_at" IS NOT NULL))
);

CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "receiver_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlements_amount_positive" CHECK ("amount_paise" > 0 AND "amount_paise" <= 1000000000),
    CONSTRAINT "settlements_distinct_people" CHECK ("payer_id" <> "receiver_id"),
    CONSTRAINT "settlements_currency_inr" CHECK ("currency" = 'INR'),
    CONSTRAINT "settlements_status_dates" CHECK (
      ("status" = 'PENDING' AND "decided_at" IS NULL AND "cancelled_at" IS NULL)
      OR ("status" IN ('CONFIRMED', 'REJECTED') AND "decided_at" IS NOT NULL AND "cancelled_at" IS NULL)
      OR ("status" = 'CANCELLED' AND "decided_at" IS NULL AND "cancelled_at" IS NOT NULL)
    )
);

CREATE INDEX "expense_disputes_expense_id_status_created_at_idx" ON "expense_disputes"("expense_id", "status", "created_at");
CREATE INDEX "expense_disputes_reporter_id_status_created_at_idx" ON "expense_disputes"("reporter_id", "status", "created_at");
CREATE UNIQUE INDEX "expense_disputes_one_open_per_reporter" ON "expense_disputes"("expense_id", "reporter_id") WHERE "status" = 'OPEN';
CREATE INDEX "settlements_trip_id_status_created_at_idx" ON "settlements"("trip_id", "status", "created_at");
CREATE INDEX "settlements_payer_id_status_created_at_idx" ON "settlements"("payer_id", "status", "created_at");
CREATE INDEX "settlements_receiver_id_status_created_at_idx" ON "settlements"("receiver_id", "status", "created_at");
CREATE UNIQUE INDEX "settlements_one_pending_per_pair" ON "settlements"("trip_id", "payer_id", "receiver_id") WHERE "status" = 'PENDING';

ALTER TABLE "expense_disputes" ADD CONSTRAINT "expense_disputes_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_disputes" ADD CONSTRAINT "expense_disputes_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
