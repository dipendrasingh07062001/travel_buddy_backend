-- CreateEnum
CREATE TYPE "TripDateMode" AS ENUM ('EXACT', 'WINDOW');

-- AlterTable: existing trips keep their meaning as exact dates.
ALTER TABLE "trips" ADD COLUMN     "date_mode" "TripDateMode" NOT NULL DEFAULT 'EXACT',
ADD COLUMN     "weekends_only" BOOLEAN NOT NULL DEFAULT false;

-- An exact trip's length is its date range. A window holds a trip of the
-- entered length, spans at most 92 days and replaces day flexibility. A weekend
-- window allows up to four days and must contain a Saturday or Sunday: with
-- ISO weekdays (Monday 1 ... Sunday 7) that means the range reaches day 6.
ALTER TABLE "trips" ADD CONSTRAINT "trips_date_mode_check" CHECK (
  (
    "date_mode" = 'EXACT'
    AND "duration_days" = "end_date" - "start_date" + 1
    AND NOT "weekends_only"
  )
  OR (
    "date_mode" = 'WINDOW'
    AND "duration_days" <= "end_date" - "start_date" + 1
    AND "end_date" - "start_date" + 1 <= 92
    AND "flexibility_days" = 0
    AND (
      NOT "weekends_only"
      OR (
        "duration_days" <= 4
        AND EXTRACT(ISODOW FROM "start_date") + ("end_date" - "start_date") >= 6
      )
    )
  )
);
