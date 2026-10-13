import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  deleteObjectQuietly,
  requireStorage,
  type ObjectStorage,
} from '../../storage/object-storage.js';
import {
  processProfilePhoto,
  readSingleUpload,
} from '../../storage/uploads.js';
import { presentAuthenticatedUser } from '../auth/auth.presenter.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { setProfilePhotoKey } from './profile-photo.repository.js';
import { privateUserSchema } from './profile.schemas.js';

const maximumPhotoBytes = 5 * 1024 * 1024;

const privateUserResponse = {
  type: 'object',
  required: ['data'],
  properties: { data: privateUserSchema },
} as const;

export async function registerProfilePhotoRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  storage: ObjectStorage | null,
): Promise<void> {
  app.put(
    '/me/profile-photo',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['Profiles'],
        summary: 'Upload or replace your profile photo',
        description:
          'Send multipart/form-data with one file in the "photo" field: JPEG, PNG, or WebP, up to 5 MB. The photo is cropped to 512x512, converted to WebP, and stripped of metadata such as GPS location.',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        response: { 200: privateUserResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const store = requireStorage(storage);
      const photo = await processProfilePhoto(
        await readSingleUpload(request, 'photo', maximumPhotoBytes),
      );
      const key = `profile-photos/${user.id}/${randomUUID()}.${photo.extension}`;
      await store.putObject({
        bucket: 'public',
        key,
        body: photo.body,
        contentType: photo.contentType,
        // Every upload gets a new key, so the file never changes in place.
        cacheControl: 'public, max-age=31536000, immutable',
      });

      let change;
      try {
        change = await setProfilePhotoKey(user.id, key);
      } catch (error) {
        await deleteObjectQuietly(store, 'public', key, request.log);
        throw error;
      }
      if (change.previousKey) {
        await deleteObjectQuietly(
          store,
          'public',
          change.previousKey,
          request.log,
        );
      }
      return { data: presentAuthenticatedUser(change.user) };
    },
  );

  app.delete(
    '/me/profile-photo',
    {
      schema: {
        tags: ['Profiles'],
        summary: 'Remove your profile photo',
        security: [{ bearerAuth: [] }],
        response: { 200: privateUserResponse },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const store = requireStorage(storage);
      const change = await setProfilePhotoKey(user.id, null);
      if (change.previousKey) {
        await deleteObjectQuietly(
          store,
          'public',
          change.previousKey,
          request.log,
        );
      }
      return { data: presentAuthenticatedUser(change.user) };
    },
  );
}
