-- Firebase owns login sessions. PostgreSQL stores the provider-to-user link.
CREATE TYPE "AuthProvider" AS ENUM ('FIREBASE');

CREATE TABLE "auth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_subject" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_accounts_provider_provider_subject_key"
    ON "auth_accounts"("provider", "provider_subject");

CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts"("user_id");

ALTER TABLE "auth_accounts"
    ADD CONSTRAINT "auth_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "sessions";
