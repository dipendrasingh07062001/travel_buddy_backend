-- A separate migration because PostgreSQL cannot use an enum value in the
-- transaction that added it (20261014090000_profile_photo_moderation).
ALTER TABLE "reports" DROP CONSTRAINT "reports_one_target";

ALTER TABLE "reports" ADD CONSTRAINT "reports_one_target" CHECK (
  ("target_type" = 'USER' AND "reported_user_id" IS NOT NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'TRIP' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NOT NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'CONNECTION_REQUEST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NOT NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'MESSAGE' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NOT NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'COMMUNITY_POST' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NOT NULL AND "reported_community_comment_id" IS NULL)
  OR ("target_type" = 'COMMUNITY_COMMENT' AND "reported_user_id" IS NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NOT NULL)
  OR ("target_type" = 'PROFILE_PHOTO' AND "reported_user_id" IS NOT NULL AND "reported_photo_key" IS NOT NULL AND "reported_trip_id" IS NULL AND "reported_connection_request_id" IS NULL AND "reported_message_id" IS NULL AND "reported_community_post_id" IS NULL AND "reported_community_comment_id" IS NULL)
);

-- Only profile-photo reports refer to a photo.
ALTER TABLE "reports" ADD CONSTRAINT "reports_photo_key_only_for_photos"
CHECK ("target_type" = 'PROFILE_PHOTO' OR "reported_photo_key" IS NULL);
