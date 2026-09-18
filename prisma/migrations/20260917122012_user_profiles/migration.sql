-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'MEMBERS_ONLY', 'PRIVATE');

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "profile_photo_storage_key" VARCHAR(500),
    "home_city" VARCHAR(120),
    "home_region" VARCHAR(120),
    "biography" VARCHAR(500),
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "travel_interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "past_trips_visibility" "ProfileVisibility" NOT NULL DEFAULT 'MEMBERS_ONLY',
    "community_activity_visibility" "ProfileVisibility" NOT NULL DEFAULT 'PUBLIC',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_profiles"
    ADD CONSTRAINT "user_profiles_photo_key_check"
        CHECK ("profile_photo_storage_key" IS NULL OR length(btrim("profile_photo_storage_key")) > 0),
    ADD CONSTRAINT "user_profiles_home_city_check"
        CHECK ("home_city" IS NULL OR length(btrim("home_city")) > 0),
    ADD CONSTRAINT "user_profiles_home_region_check"
        CHECK ("home_region" IS NULL OR length(btrim("home_region")) > 0),
    ADD CONSTRAINT "user_profiles_biography_check"
        CHECK ("biography" IS NULL OR length(btrim("biography")) > 0),
    ADD CONSTRAINT "user_profiles_languages_count_check"
        CHECK (cardinality("languages") <= 10),
    ADD CONSTRAINT "user_profiles_interests_count_check"
        CHECK (cardinality("travel_interests") <= 20);

-- CreateIndex
CREATE INDEX "user_profiles_home_city_idx" ON "user_profiles"("home_city");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
