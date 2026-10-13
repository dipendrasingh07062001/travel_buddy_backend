import { createHash } from 'node:crypto';

import { AwsClient } from 'aws4fetch';

import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

// Profile photos live in a public bucket served from R2_PUBLIC_BASE_URL.
// Receipts live in a private bucket and are only reachable through
// short-lived signed URLs handed to authorised trip members.
export type StorageBucket = 'public' | 'private';

export interface PutObjectInput {
  bucket: StorageBucket;
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(bucket: StorageBucket, key: string): Promise<void>;
  signedPrivateUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBucket: string;
  privateBucket: string;
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function createR2Storage(
  settings: R2Settings,
  send: typeof fetch = fetch,
): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const endpoint = `https://${settings.accountId}.r2.cloudflarestorage.com`;
  const objectUrl = (bucket: StorageBucket, key: string) =>
    `${endpoint}/${
      bucket === 'public' ? settings.publicBucket : settings.privateBucket
    }/${encodeKey(key)}`;

  return {
    async putObject(input) {
      const request = await client.sign(objectUrl(input.bucket, input.key), {
        method: 'PUT',
        // Node Buffers are always backed by a plain ArrayBuffer.
        body: input.body as Uint8Array<ArrayBuffer>,
        headers: {
          'content-type': input.contentType,
          'cache-control': input.cacheControl,
          // Signing the real payload hash lets R2 reject a corrupted upload.
          'x-amz-content-sha256': createHash('sha256')
            .update(input.body)
            .digest('hex'),
        },
      });
      const response = await send(request);
      if (!response.ok) {
        throw new Error(`R2 upload failed with HTTP ${response.status}.`);
      }
    },

    async deleteObject(bucket, key) {
      const request = await client.sign(objectUrl(bucket, key), {
        method: 'DELETE',
      });
      const response = await send(request);
      if (!response.ok && response.status !== 404) {
        throw new Error(`R2 delete failed with HTTP ${response.status}.`);
      }
    },

    async signedPrivateUrl(key, expiresInSeconds) {
      const url = new URL(objectUrl('private', key));
      url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
      const request = await client.sign(url.toString(), {
        method: 'GET',
        aws: { signQuery: true },
      });
      return request.url;
    },
  };
}

export function configuredObjectStorage(): ObjectStorage | null {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_PUBLIC_BUCKET ||
    !env.R2_PRIVATE_BUCKET
  ) {
    return null;
  }
  return createR2Storage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    publicBucket: env.R2_PUBLIC_BUCKET,
    privateBucket: env.R2_PRIVATE_BUCKET,
  });
}

export function requireStorage(storage: ObjectStorage | null): ObjectStorage {
  if (!storage) {
    throw new AppError(
      503,
      'STORAGE_UNAVAILABLE',
      'File uploads are not configured on this server.',
    );
  }
  return storage;
}

// Public objects use random keys, so a URL cannot be guessed, and each upload
// gets a new key, so URLs can be cached forever.
export function publicObjectUrl(
  key: string | null | undefined,
  baseUrl: string | undefined = env.R2_PUBLIC_BASE_URL,
): string | null {
  if (!key || !baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`;
}

// Used after the database already points elsewhere: a failed delete leaves an
// unreferenced object behind, which is logged rather than failing the request.
export async function deleteObjectQuietly(
  storage: ObjectStorage,
  bucket: StorageBucket,
  key: string,
  logger: { warn(object: object, message: string): void },
): Promise<void> {
  try {
    await storage.deleteObject(bucket, key);
  } catch (error) {
    logger.warn({ err: error, bucket, key }, 'Could not delete stored object');
  }
}
