import type { PushPlatform } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  listPushDevices,
  registerPushDevice,
  removePushDevice,
  type PushDeviceRecord,
} from './push-device.repository.js';

const pushDeviceSchema = {
  type: 'object',
  required: ['id', 'platform', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    platform: { type: 'string', enum: ['ANDROID', 'IOS', 'WEB'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

// The token itself is never returned: it is a delivery credential for the
// device, and the client already has it.
function presentPushDevice(device: PushDeviceRecord) {
  return {
    id: device.id,
    platform: device.platform,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

export async function registerPushDeviceRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.post<{ Body: { token: string; platform: PushPlatform } }>(
    '/me/push-devices',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Notifications'],
        summary: 'Register or refresh this device for push notifications',
        description:
          'Send the Firebase Cloud Messaging registration token after the user allows notifications, and again whenever the token changes. Registering a token is the per-device opt-in.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token', 'platform'],
          properties: {
            token: {
              type: 'string',
              minLength: 20,
              maxLength: 512,
              pattern: '^[A-Za-z0-9_:.\\-]+$',
            },
            platform: { type: 'string', enum: ['ANDROID', 'IOS', 'WEB'] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: pushDeviceSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const device = await registerPushDevice(
        user.id,
        request.body.token,
        request.body.platform,
      );
      return { data: presentPushDevice(device) };
    },
  );

  app.get(
    '/me/push-devices',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'List devices registered for your push notifications',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: { type: 'array', items: pushDeviceSchema } },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const devices = await listPushDevices(user.id);
      return { data: devices.map(presentPushDevice) };
    },
  );

  app.delete<{ Params: { deviceId: string } }>(
    '/me/push-devices/:deviceId',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Stop push notifications to one of your devices',
        description:
          'Call this when the user signs out or turns notifications off on the device.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['deviceId'],
          properties: { deviceId: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const user = await authenticateRequest(request, auth);
      await removePushDevice(user.id, request.params.deviceId);
      return reply.code(204).send();
    },
  );
}
