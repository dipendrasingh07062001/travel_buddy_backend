-- New enum values must be committed before they can be used, so they get a
-- migration of their own.
ALTER TYPE "UserStatus" ADD VALUE 'PENDING_DELETION';
ALTER TYPE "AccountDataRequestStatus" ADD VALUE 'COMPLETED';
