CREATE TYPE "ExpenseStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "ExpenseSplitMethod" AS ENUM ('EQUAL', 'CUSTOM');
CREATE TYPE "ExpenseCategory" AS ENUM ('ACCOMMODATION', 'TRANSPORT', 'FOOD', 'FUEL', 'ACTIVITY', 'SHOPPING', 'OTHER');
CREATE TYPE "ExpenseRevisionAction" AS ENUM ('CREATE', 'EDIT', 'VOID');

CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "paid_by_id" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "split_method" "ExpenseSplitMethod" NOT NULL,
    "expense_date" DATE NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expenses_amount_positive" CHECK ("amount_paise" > 0 AND "amount_paise" <= 1000000000),
    CONSTRAINT "expenses_version_positive" CHECK ("version" > 0),
    CONSTRAINT "expenses_void_state" CHECK (("status" = 'ACTIVE' AND "voided_at" IS NULL) OR ("status" = 'VOIDED' AND "voided_at" IS NOT NULL)),
    CONSTRAINT "expenses_currency_inr" CHECK ("currency" = 'INR')
);

CREATE TABLE "expense_shares" (
    "expense_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    CONSTRAINT "expense_shares_pkey" PRIMARY KEY ("expense_id", "user_id"),
    CONSTRAINT "expense_shares_amount_nonnegative" CHECK ("amount_paise" >= 0)
);

CREATE TABLE "expense_revisions" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" "ExpenseRevisionAction" NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expenses_trip_id_status_created_at_idx" ON "expenses"("trip_id", "status", "created_at");
CREATE INDEX "expenses_created_by_id_created_at_idx" ON "expenses"("created_by_id", "created_at");
CREATE INDEX "expense_shares_user_id_idx" ON "expense_shares"("user_id");
CREATE UNIQUE INDEX "expense_revisions_expense_id_version_key" ON "expense_revisions"("expense_id", "version");
CREATE INDEX "expense_revisions_actor_id_created_at_idx" ON "expense_revisions"("actor_id", "created_at");

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_revisions" ADD CONSTRAINT "expense_revisions_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_revisions" ADD CONSTRAINT "expense_revisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Expense and share writes happen in one transaction. Check the sum at commit,
-- so even a direct SQL writer cannot persist a ledger with missing or extra shares.
CREATE FUNCTION check_expense_share_total() RETURNS TRIGGER AS $$
DECLARE
    checked_expense_id UUID;
    expected_amount INTEGER;
    actual_amount BIGINT;
    share_count INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'expenses' THEN
        checked_expense_id := COALESCE(NEW.id, OLD.id);
    ELSE
        checked_expense_id := COALESCE(NEW.expense_id, OLD.expense_id);
    END IF;
    SELECT amount_paise INTO expected_amount FROM expenses WHERE id = checked_expense_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT COUNT(*), COALESCE(SUM(amount_paise), 0)
      INTO share_count, actual_amount
      FROM expense_shares WHERE expense_id = checked_expense_id;
    IF share_count = 0 OR actual_amount <> expected_amount THEN
        RAISE EXCEPTION 'Expense shares must sum to the expense amount' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER expense_total_after_expense
AFTER INSERT OR UPDATE ON expenses DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_expense_share_total();

CREATE CONSTRAINT TRIGGER expense_total_after_share
AFTER INSERT OR UPDATE OR DELETE ON expense_shares DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_expense_share_total();
