CREATE TYPE "AccountDataRequestType" AS ENUM ('ACCESS', 'ACCOUNT_DELETION');
CREATE TYPE "AccountDataRequestStatus" AS ENUM ('OPEN', 'CANCELLED');

CREATE TABLE "account_data_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AccountDataRequestType" NOT NULL,
    "status" "AccountDataRequestStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),
    CONSTRAINT "account_data_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_data_requests_user_id_created_at_id_idx"
    ON "account_data_requests"("user_id", "created_at", "id");
CREATE INDEX "account_data_requests_status_created_at_id_idx"
    ON "account_data_requests"("status", "created_at", "id");
CREATE UNIQUE INDEX "account_data_requests_one_open_per_type_idx"
    ON "account_data_requests"("user_id", "type") WHERE "status" = 'OPEN';

ALTER TABLE "account_data_requests" ADD CONSTRAINT "account_data_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
