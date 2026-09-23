CREATE TYPE "TripChecklistItemStatus" AS ENUM ('OPEN', 'COMPLETED', 'REMOVED');

CREATE TABLE "trip_checklist_items" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "completed_by_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "status" "TripChecklistItemStatus" NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trip_checklist_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trip_checklist_items_trip_id_status_created_at_idx"
ON "trip_checklist_items"("trip_id", "status", "created_at");

CREATE INDEX "trip_checklist_items_created_by_id_created_at_idx"
ON "trip_checklist_items"("created_by_id", "created_at");

ALTER TABLE "trip_checklist_items"
ADD CONSTRAINT "trip_checklist_items_trip_id_fkey"
FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trip_checklist_items"
ADD CONSTRAINT "trip_checklist_items_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trip_checklist_items"
ADD CONSTRAINT "trip_checklist_items_completed_by_id_fkey"
FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trip_checklist_items"
ADD CONSTRAINT "trip_checklist_items_completion_state" CHECK (
  ("status" = 'OPEN' AND "completed_by_id" IS NULL AND "completed_at" IS NULL AND "removed_at" IS NULL)
  OR ("status" = 'COMPLETED' AND "completed_by_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "removed_at" IS NULL)
  OR ("status" = 'REMOVED' AND "removed_at" IS NOT NULL)
);
