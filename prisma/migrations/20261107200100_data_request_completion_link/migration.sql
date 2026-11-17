-- Links each manual completion's audit row to the request it completed.
-- AlterTable
ALTER TABLE "moderation_actions" ADD COLUMN     "data_request_id" UUID;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_id_fkey" FOREIGN KEY ("data_request_id") REFERENCES "account_data_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only completion rows carry the link, and every completion row has one.
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_link_check"
  CHECK ("data_request_id" IS NULL
         OR ("action" = 'DATA_REQUEST_COMPLETED' AND "target_type" = 'USER'));
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_data_request_required_check"
  CHECK ("action" <> 'DATA_REQUEST_COMPLETED' OR "data_request_id" IS NOT NULL);

-- One completion per request.
CREATE UNIQUE INDEX "moderation_actions_one_completion_per_request_idx"
  ON "moderation_actions"("data_request_id") WHERE "data_request_id" IS NOT NULL;
