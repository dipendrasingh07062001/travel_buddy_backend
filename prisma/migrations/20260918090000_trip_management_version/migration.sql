ALTER TABLE "trips"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "trips"
ADD CONSTRAINT "trips_version_positive" CHECK ("version" > 0);
