ALTER TYPE "NotificationType" ADD VALUE 'MATCHING_TRIP_PUBLISHED';

CREATE TABLE "trip_alert_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "origin" VARCHAR(120),
    "departure_from" DATE,
    "departure_to" DATE,
    "min_budget" DECIMAL(12,2),
    "max_budget" DECIMAL(12,2),
    "min_duration" INTEGER,
    "max_duration" INTEGER,
    "transport" "TripTransport",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "trip_alert_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trip_alert_budget_bounds" CHECK (
      ("min_budget" IS NULL OR "min_budget" >= 0) AND
      ("max_budget" IS NULL OR "max_budget" >= 0) AND
      ("min_budget" IS NULL OR "max_budget" IS NULL OR "min_budget" <= "max_budget")
    ),
    CONSTRAINT "trip_alert_date_bounds" CHECK (
      "departure_from" IS NULL OR "departure_to" IS NULL OR "departure_from" <= "departure_to"
    ),
    CONSTRAINT "trip_alert_duration_bounds" CHECK (
      ("min_duration" IS NULL OR "min_duration" BETWEEN 1 AND 365) AND
      ("max_duration" IS NULL OR "max_duration" BETWEEN 1 AND 365) AND
      ("min_duration" IS NULL OR "max_duration" IS NULL OR "min_duration" <= "max_duration")
    )
);

CREATE INDEX "trip_alert_subscriptions_user_id_created_at_id_idx"
  ON "trip_alert_subscriptions"("user_id", "created_at", "id");
CREATE INDEX "trip_alert_subscriptions_community_id_enabled_id_idx"
  ON "trip_alert_subscriptions"("community_id", "enabled", "id");
ALTER TABLE "trip_alert_subscriptions" ADD CONSTRAINT "trip_alert_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_alert_subscriptions" ADD CONSTRAINT "trip_alert_subscriptions_community_id_fkey"
  FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "trip_publication_alerts" (
    "trip_id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "cursor_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "trip_publication_alerts_pkey" PRIMARY KEY ("trip_id")
);
CREATE INDEX "trip_publication_alerts_completed_at_next_attempt_at_publis_idx"
  ON "trip_publication_alerts"("completed_at", "next_attempt_at", "published_at");
ALTER TABLE "trip_publication_alerts" ADD CONSTRAINT "trip_publication_alerts_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
