-- CreateEnum
CREATE TYPE "CommunityStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'FULL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripTransport" AS ENUM ('BUS', 'TRAIN', 'FLIGHT', 'CAR', 'MOTORCYCLE', 'OTHER', 'UNDECIDED');

-- CreateTable
CREATE TABLE "communities" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "region" VARCHAR(120),
    "country_code" CHAR(2) NOT NULL DEFAULT 'IN',
    "description" TEXT,
    "status" "CommunityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "origin_city" VARCHAR(120) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "flexibility_days" INTEGER NOT NULL DEFAULT 0,
    "duration_days" INTEGER NOT NULL,
    "budget_min" DECIMAL(12,2),
    "budget_max" DECIMAL(12,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "current_group_size" INTEGER NOT NULL DEFAULT 1,
    "desired_group_size" INTEGER NOT NULL,
    "transport" "TripTransport" NOT NULL DEFAULT 'UNDECIDED',
    "description" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- Business invariants are enforced in PostgreSQL as a final line of defense.
ALTER TABLE "communities"
    ADD CONSTRAINT "communities_country_code_check"
    CHECK ("country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "trips"
    ADD CONSTRAINT "trips_date_range_check"
        CHECK ("end_date" >= "start_date"),
    ADD CONSTRAINT "trips_flexibility_days_check"
        CHECK ("flexibility_days" BETWEEN 0 AND 30),
    ADD CONSTRAINT "trips_duration_days_check"
        CHECK ("duration_days" > 0),
    ADD CONSTRAINT "trips_budget_min_check"
        CHECK ("budget_min" IS NULL OR "budget_min" >= 0),
    ADD CONSTRAINT "trips_budget_max_check"
        CHECK ("budget_max" IS NULL OR "budget_max" >= 0),
    ADD CONSTRAINT "trips_budget_range_check"
        CHECK ("budget_min" IS NULL OR "budget_max" IS NULL OR "budget_max" >= "budget_min"),
    ADD CONSTRAINT "trips_currency_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "trips_group_size_check"
        CHECK ("current_group_size" >= 1 AND "desired_group_size" BETWEEN "current_group_size" AND 100),
    ADD CONSTRAINT "trips_publication_check"
        CHECK ("status" NOT IN ('PUBLISHED', 'FULL') OR "published_at" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");

-- CreateIndex
CREATE INDEX "communities_status_name_idx" ON "communities"("status", "name");

-- CreateIndex
CREATE INDEX "trips_status_start_date_idx" ON "trips"("status", "start_date");

-- CreateIndex
CREATE INDEX "trips_community_id_status_start_date_idx" ON "trips"("community_id", "status", "start_date");

-- CreateIndex
CREATE INDEX "trips_owner_id_idx" ON "trips"("owner_id");

-- CreateIndex
CREATE INDEX "trips_origin_city_idx" ON "trips"("origin_city");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
