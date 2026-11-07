-- An administrator finished an ACCESS data request by hand. Added alone
-- because PostgreSQL cannot use a new enum value in the transaction that
-- adds it, and the next migration's CHECKs use it.
-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'DATA_REQUEST_COMPLETED';
