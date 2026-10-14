-- A member who left a trip may ask to join it again, so one user can make
-- several requests for the same trip over time, but only one may be waiting.
DROP INDEX "connection_requests_trip_id_requester_id_key";

CREATE INDEX "connection_requests_trip_id_requester_id_created_at_idx"
    ON "connection_requests"("trip_id", "requester_id", "created_at");

CREATE UNIQUE INDEX "connection_requests_one_pending_per_requester_key"
    ON "connection_requests"("trip_id", "requester_id") WHERE "status" = 'PENDING';
