-- Staff looked up an account by an exact email or phone (admin user search).
-- The searched value is never stored.
-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'USER_LOOKED_UP';
