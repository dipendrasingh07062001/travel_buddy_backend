import type { FastifyInstance } from 'fastify';

import { AppError } from '../../errors/app-error.js';
import { presentAuthenticatedUser } from '../auth/auth.presenter.js';
import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { presentPublicProfile } from './profile.presenter.js';
import { prismaProfileRepository } from './profile.repository.js';
import {
  privateUserSchema,
  profileVisibilityValues,
  publicUserSchema,
} from './profile.schemas.js';
import {
  normalizeProfileUpdate,
  type UpdateProfileBody,
} from './profile.service.js';
import type { ProfileRouteDependencies } from './profile.types.js';

interface UserParams {
  userId: string;
}

const nullableText = (maxLength: number) => ({
  anyOf: [{ type: 'string', maxLength, minLength: 1 }, { type: 'null' }],
});

export async function registerProfileRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  overrides: Partial<ProfileRouteDependencies> = {},
): Promise<void> {
  const repository = overrides.repository ?? prismaProfileRepository;

  app.patch<{ Body: UpdateProfileBody }>(
    '/me/profile',
    {
      schema: {
        tags: ['Profiles'],
        summary: 'Update the current user profile and privacy settings',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            displayName: { type: 'string', minLength: 2, maxLength: 100 },
            birthDate: { type: 'string', format: 'date' },
            homeCity: nullableText(120),
            homeRegion: nullableText(120),
            biography: nullableText(500),
            languages: {
              type: 'array',
              maxItems: 10,
              uniqueItems: true,
              items: { type: 'string', minLength: 2, maxLength: 35 },
            },
            travelInterests: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', minLength: 2, maxLength: 50 },
            },
            pastTripsVisibility: {
              type: 'string',
              enum: profileVisibilityValues,
            },
            communityActivityVisibility: {
              type: 'string',
              enum: profileVisibilityValues,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: privateUserSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const updated = await repository.update(
        user.id,
        normalizeProfileUpdate(request.body),
      );
      return { data: presentAuthenticatedUser(updated) };
    },
  );

  app.get<{ Params: UserParams }>(
    '/users/:userId',
    {
      schema: {
        tags: ['Profiles'],
        summary: 'Get the safe public portion of a user profile',
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: publicUserSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await repository.findPublicByUserId(request.params.userId);
      if (!user) {
        throw new AppError(404, 'NOT_FOUND', 'User profile not found.');
      }
      return { data: presentPublicProfile(user) };
    },
  );
}
