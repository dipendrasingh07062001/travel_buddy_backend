-- Prevent concurrent requests from creating duplicate unresolved reports.
CREATE UNIQUE INDEX "reports_open_user_target_key"
ON "reports"("reporter_id", "reported_user_id")
WHERE "reported_user_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');

CREATE UNIQUE INDEX "reports_open_trip_target_key"
ON "reports"("reporter_id", "reported_trip_id")
WHERE "reported_trip_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');

CREATE UNIQUE INDEX "reports_open_connection_target_key"
ON "reports"("reporter_id", "reported_connection_request_id")
WHERE "reported_connection_request_id" IS NOT NULL AND "status" IN ('SUBMITTED', 'UNDER_REVIEW');
