CREATE TYPE "AccountCleanupKind" AS ENUM ('FIREBASE_ACCOUNT', 'PUBLIC_OBJECT', 'PRIVATE_OBJECT');

CREATE TABLE "account_cleanup_tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AccountCleanupKind" NOT NULL,
    "target" VARCHAR(1024) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_cleanup_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_cleanup_tasks_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "account_cleanup_tasks_target_check" CHECK (length("target") > 0),
    CONSTRAINT "account_cleanup_tasks_claim_check" CHECK (("claim_token" IS NULL) = ("claimed_at" IS NULL))
);

CREATE UNIQUE INDEX "account_cleanup_tasks_kind_target_key" ON "account_cleanup_tasks"("kind", "target");
CREATE INDEX "account_cleanup_tasks_next_attempt_at_created_at_id_idx" ON "account_cleanup_tasks"("next_attempt_at", "created_at", "id");
CREATE INDEX "account_cleanup_tasks_user_id_idx" ON "account_cleanup_tasks"("user_id");

ALTER TABLE "account_cleanup_tasks" ADD CONSTRAINT "account_cleanup_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
