-- Optional private context for an expense, such as "includes tip".
-- Existing expenses have no note.
ALTER TABLE "expenses" ADD COLUMN     "note" VARCHAR(500);
