-- A trip names its destination either by linking an active community or by a
-- typed name (PRD 7.1), and its description becomes optional. Existing trips
-- all link a community, so no backfill is needed.
ALTER TABLE "trips" ADD COLUMN     "destination_name" VARCHAR(120),
ALTER COLUMN "community_id" DROP NOT NULL,
ALTER COLUMN "description" DROP NOT NULL;

-- Exactly one destination. Written so that no row can make it NULL, which a
-- CHECK would accept.
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_check" CHECK (
  ("community_id" IS NOT NULL AND "destination_name" IS NULL)
  OR ("community_id" IS NULL AND "destination_name" IS NOT NULL
      AND btrim("destination_name") <> '')
);
