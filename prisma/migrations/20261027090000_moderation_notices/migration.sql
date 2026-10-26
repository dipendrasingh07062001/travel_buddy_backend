-- In-app notices for moderation actions on a user's content or account.
ALTER TYPE "NotificationType" ADD VALUE 'TRIP_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE 'COMMUNITY_POST_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE 'COMMUNITY_COMMENT_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE 'MESSAGE_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_SUSPENDED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_RESTORED';
