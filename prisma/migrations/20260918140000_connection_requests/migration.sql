CREATE TYPE "ConnectionRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'BLOCKED');
CREATE TYPE "TripMembershipRole" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "TripMembershipStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

CREATE TABLE "connection_requests" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "requester_id" UUID NOT NULL,
  "recipient_id" UUID NOT NULL,
  "related_trip_id" UUID,
  "message" VARCHAR(500) NOT NULL,
  "status" "ConnectionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "withdrawn_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "connection_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trip_memberships" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "connection_request_id" UUID,
  "role" "TripMembershipRole" NOT NULL,
  "status" "TripMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at" TIMESTAMPTZ(6),
  "removed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "trip_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connection_requests_trip_id_requester_id_key"
ON "connection_requests"("trip_id", "requester_id");
CREATE INDEX "connection_requests_recipient_id_status_created_at_idx"
ON "connection_requests"("recipient_id", "status", "created_at");
CREATE INDEX "connection_requests_requester_id_status_created_at_idx"
ON "connection_requests"("requester_id", "status", "created_at");

CREATE UNIQUE INDEX "trip_memberships_connection_request_id_key"
ON "trip_memberships"("connection_request_id");
CREATE UNIQUE INDEX "trip_memberships_trip_id_user_id_key"
ON "trip_memberships"("trip_id", "user_id");
CREATE INDEX "trip_memberships_user_id_status_idx"
ON "trip_memberships"("user_id", "status");
CREATE INDEX "trip_memberships_trip_id_status_idx"
ON "trip_memberships"("trip_id", "status");

ALTER TABLE "connection_requests"
ADD CONSTRAINT "connection_requests_trip_id_fkey"
FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connection_requests"
ADD CONSTRAINT "connection_requests_related_trip_id_fkey"
FOREIGN KEY ("related_trip_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "connection_requests"
ADD CONSTRAINT "connection_requests_requester_id_fkey"
FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connection_requests"
ADD CONSTRAINT "connection_requests_recipient_id_fkey"
FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connection_requests"
ADD CONSTRAINT "connection_requests_decided_by_id_fkey"
FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trip_memberships"
ADD CONSTRAINT "trip_memberships_trip_id_fkey"
FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_memberships"
ADD CONSTRAINT "trip_memberships_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trip_memberships"
ADD CONSTRAINT "trip_memberships_connection_request_id_fkey"
FOREIGN KEY ("connection_request_id") REFERENCES "connection_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "trip_memberships" (
  "id", "trip_id", "user_id", "role", "status", "joined_at", "created_at", "updated_at"
)
SELECT gen_random_uuid(), "id", "owner_id", 'OWNER', 'ACTIVE', "created_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "trips";
