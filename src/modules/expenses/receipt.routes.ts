import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  deleteObjectQuietly,
  requireStorage,
  type ObjectStorage,
} from '../../storage/object-storage.js';
import { processReceipt, readSingleUpload } from '../../storage/uploads.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  addReceipt,
  listReceipts,
  receiptUploadTarget,
  removeReceipt,
  type ReceiptRecord,
} from './receipt.repository.js';

const maximumReceiptBytes = 10 * 1024 * 1024;
// Long enough to open or download the file, short enough that a leaked link
// stops working soon after.
const signedUrlSeconds = 15 * 60;

const receiptSchema = {
  type: 'object',
  required: [
    'id',
    'expenseId',
    'contentType',
    'sizeBytes',
    'uploadedBy',
    'createdAt',
    'url',
    'urlExpiresAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    expenseId: { type: 'string', format: 'uuid' },
    contentType: { type: 'string', enum: ['image/webp', 'application/pdf'] },
    sizeBytes: { type: 'integer' },
    uploadedBy: {
      type: 'object',
      required: ['id', 'displayName'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    url: { type: 'string', format: 'uri' },
    urlExpiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

const expenseParams = {
  type: 'object',
  required: ['expenseId'],
  properties: { expenseId: { type: 'string', format: 'uuid' } },
} as const;

async function presentReceipts(
  receipts: ReceiptRecord[],
  storage: ObjectStorage,
  now = new Date(),
) {
  const urlExpiresAt = new Date(
    now.getTime() + signedUrlSeconds * 1000,
  ).toISOString();
  return Promise.all(
    receipts.map(async (receipt) => ({
      id: receipt.id,
      expenseId: receipt.expenseId,
      contentType: receipt.contentType,
      sizeBytes: receipt.sizeBytes,
      uploadedBy: receipt.uploadedBy,
      createdAt: receipt.createdAt.toISOString(),
      url: await storage.signedPrivateUrl(receipt.storageKey, signedUrlSeconds),
      urlExpiresAt,
    })),
  );
}

export async function registerReceiptRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  storage: ObjectStorage | null,
): Promise<void> {
  app.post<{ Params: { expenseId: string } }>(
    '/expenses/:expenseId/receipts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
      schema: {
        tags: ['Expenses'],
        summary: 'Attach a receipt to an expense',
        description:
          'Send multipart/form-data with one file in the "receipt" field: a JPEG, PNG, or WebP image, or a PDF, up to 10 MB. Images are converted to WebP, limited to 2000 px, and stripped of metadata. Only the member who recorded or paid the expense can attach receipts, at most 5 per expense.',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        params: expenseParams,
        response: {
          201: {
            type: 'object',
            required: ['data'],
            properties: { data: receiptSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const store = requireStorage(storage);
      const { expenseId } = request.params;
      const { tripId } = await receiptUploadTarget(expenseId, user.id);
      const file = await processReceipt(
        await readSingleUpload(request, 'receipt', maximumReceiptBytes),
      );
      const key = `receipts/${tripId}/${expenseId}/${randomUUID()}.${file.extension}`;
      await store.putObject({
        bucket: 'private',
        key,
        body: file.body,
        contentType: file.contentType,
        cacheControl: 'private, no-store',
      });

      let receipt;
      try {
        receipt = await addReceipt({
          expenseId,
          actorId: user.id,
          storageKey: key,
          contentType: file.contentType,
          sizeBytes: file.body.byteLength,
        });
      } catch (error) {
        await deleteObjectQuietly(store, 'private', key, request.log);
        throw error;
      }
      const [presented] = await presentReceipts([receipt], store);
      return reply.code(201).send({ data: presented });
    },
  );

  app.get<{ Params: { expenseId: string } }>(
    '/expenses/:expenseId/receipts',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'List receipts attached to an expense',
        description:
          'Each receipt includes a signed download URL that expires after 15 minutes. Request the list again for fresh URLs.',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: { type: 'array', items: receiptSchema } },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const store = requireStorage(storage);
      const receipts = await listReceipts(request.params.expenseId, user.id);
      return { data: await presentReceipts(receipts, store) };
    },
  );

  app.delete<{ Params: { receiptId: string } }>(
    '/expense-receipts/:receiptId',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Remove a receipt and delete its file',
        description:
          'Allowed for the member who attached the receipt or recorded the expense. A record that the receipt existed is kept for the ledger history.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['receiptId'],
          properties: { receiptId: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      const store = requireStorage(storage);
      const { storageKey } = await removeReceipt(
        request.params.receiptId,
        user.id,
      );
      await deleteObjectQuietly(store, 'private', storageKey, request.log);
      return reply.code(204).send();
    },
  );
}
