-- The owner's latest confirmation, at publish, that the trip is a personal
-- plan, accurate to the best of their knowledge and not a commercial tour
-- listing (PRD 7.2), with the version of the wording they confirmed.
-- Trips published before this change have no confirmation; none is assumed.
ALTER TABLE "trips" ADD COLUMN     "publish_confirmation_version" VARCHAR(20),
ADD COLUMN     "publish_confirmed_at" TIMESTAMPTZ(6);

-- The time and the wording version are recorded together or not at all.
ALTER TABLE "trips" ADD CONSTRAINT "trips_publish_confirmation_check" CHECK (
  ("publish_confirmed_at" IS NULL) = ("publish_confirmation_version" IS NULL)
);
