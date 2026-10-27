-- Optional text saying how a settlement was paid outside Travel Buddy, such as
-- "UPI" or "Cash". Existing settlements have no method.
ALTER TABLE "settlements" ADD COLUMN     "method" VARCHAR(50);
