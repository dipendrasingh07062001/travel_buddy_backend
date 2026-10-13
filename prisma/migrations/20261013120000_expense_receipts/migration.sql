CREATE TABLE "expense_receipts" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by_id" UUID,
    CONSTRAINT "expense_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_receipts_size_bytes_check" CHECK ("size_bytes" > 0)
);

CREATE UNIQUE INDEX "expense_receipts_storage_key_key" ON "expense_receipts"("storage_key");
CREATE INDEX "expense_receipts_expense_id_created_at_idx" ON "expense_receipts"("expense_id", "created_at");
CREATE INDEX "expense_receipts_uploaded_by_id_created_at_idx" ON "expense_receipts"("uploaded_by_id", "created_at");

ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_expense_id_fkey"
    FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_removed_by_id_fkey"
    FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
