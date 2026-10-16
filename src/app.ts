import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';

import { env } from './config/env.js';
import { checkDatabase } from './database/client.js';
import { AppError } from './errors/app-error.js';
import { resolveAuthDependencies } from './modules/auth/auth.dependencies.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { rateLimitKey } from './modules/auth/auth.service.js';
import type { AuthRouteDependencies } from './modules/auth/auth.types.js';
import { registerConnectionRoutes } from './modules/connections/connection.routes.js';
import { registerDataExportRoutes } from './modules/data-export/data-export.routes.js';
import { registerDataRequestRoutes } from './modules/data-requests/data-request.routes.js';
import type { ConnectionRouteDependencies } from './modules/connections/connection.types.js';
import { registerExpenseRoutes } from './modules/expenses/expense.routes.js';
import { registerFinancialRoutes } from './modules/expenses/financial.routes.js';
import { registerReceiptRoutes } from './modules/expenses/receipt.routes.js';
import { registerCommunityRoutes } from './modules/communities/community.routes.js';
import { registerCommunityAdminRoutes } from './modules/communities/community-admin.routes.js';
import type { CommunityRouteDependencies } from './modules/communities/community.types.js';
import { registerCommunityContentRoutes } from './modules/communities/community-content.routes.js';
import type { CommunityContentRouteDependencies } from './modules/communities/community-content.types.js';
import {
  registerHealthRoutes,
  type HealthRouteDependencies,
} from './modules/health/health.routes.js';
import { registerMessagingRoutes } from './modules/messaging/messaging.routes.js';
import type { MessagingRouteDependencies } from './modules/messaging/messaging.types.js';
import { registerModerationRoutes } from './modules/moderation/moderation.routes.js';
import { registerNotificationRoutes } from './modules/notifications/notification.routes.js';
import { registerPushDeviceRoutes } from './modules/notifications/push-device.routes.js';
import { createPolicyGate } from './modules/policies/policy-gate.js';
import { registerPolicyRoutes } from './modules/policies/policy.routes.js';
import {
  configuredPolicyCatalog,
  type PolicyCatalog,
} from './modules/policies/policy.service.js';
import { registerProfilePhotoRoutes } from './modules/profiles/profile-photo.routes.js';
import { registerProfileRoutes } from './modules/profiles/profile.routes.js';
import type { ProfileRouteDependencies } from './modules/profiles/profile.types.js';
import { registerProfileActivityRoutes } from './modules/profiles/profile-activity.routes.js';
import type { ProfileActivityDependencies } from './modules/profiles/profile-activity.types.js';
import { registerProfileSignalsRoutes } from './modules/profiles/profile-signals.routes.js';
import type { ProfileSignalsDependencies } from './modules/profiles/profile-signals.types.js';
import { registerSafetyRoutes } from './modules/safety/safety.routes.js';
import type { SafetyRouteDependencies } from './modules/safety/safety.types.js';
import { registerTripRoomRoutes } from './modules/trip-room/trip-room.routes.js';
import { registerTripAlertRoutes } from './modules/trip-alerts/trip-alert.routes.js';
import type { TripAlertDependencies } from './modules/trip-alerts/trip-alert.types.js';
import type { TripRoomRouteDependencies } from './modules/trip-room/trip-room.types.js';
import { registerTripMembershipRoutes } from './modules/trips/trip-membership.routes.js';
import type { TripMembershipRouteDependencies } from './modules/trips/trip-membership.types.js';
import {
  registerTripRoutes,
  type TripRouteDependencies,
} from './modules/trips/trip.routes.js';
import { RealtimeHub } from './realtime/realtime-hub.js';
import {
  registerRealtimeRoutes,
  type RealtimeStreamSettings,
} from './realtime/realtime.routes.js';
import {
  configuredObjectStorage,
  type ObjectStorage,
} from './storage/object-storage.js';

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  trustProxy?: FastifyServerOptions['trustProxy'];
  health?: Partial<HealthRouteDependencies>;
  trips?: Partial<TripRouteDependencies>;
  auth?: Partial<AuthRouteDependencies>;
  profiles?: Partial<ProfileRouteDependencies>;
  profileActivity?: Partial<ProfileActivityDependencies>;
  profileSignals?: Partial<ProfileSignalsDependencies>;
  connections?: Partial<ConnectionRouteDependencies>;
  safety?: Partial<SafetyRouteDependencies>;
  messaging?: Partial<MessagingRouteDependencies>;
  communities?: Partial<CommunityRouteDependencies>;
  communityContent?: Partial<CommunityContentRouteDependencies>;
  tripRoom?: Partial<TripRoomRouteDependencies>;
  tripMemberships?: Partial<TripMembershipRouteDependencies>;
  tripAlerts?: Partial<TripAlertDependencies>;
  policyCatalog?: PolicyCatalog;
  storage?: ObjectStorage | null;
  realtime?: RealtimeHub;
  realtimeStreams?: RealtimeStreamSettings;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    trustProxy: options.trustProxy ?? env.TRUST_PROXY,
    logger: options.logger ?? {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  const authDependencies = resolveAuthDependencies(options.auth);
  const storage =
    options.storage === undefined ? configuredObjectStorage() : options.storage;
  const realtime = options.realtime ?? new RealtimeHub();
  realtime.logger ??= app.log;
  // Open event streams would otherwise keep the server from closing.
  app.addHook('preClose', async () => realtime.closeAll());

  app.register(helmet);
  app.register(cors, {
    origin:
      env.CORS_ORIGINS === '*'
        ? '*'
        : env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
  });
  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      rateLimitKey(request, authDependencies.tokenVerifier),
  });
  app.register(swagger, {
    openapi: {
      info: {
        title: 'Travel Buddy API',
        description: 'HTTP API for the Travel Buddy platform',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.register(
    async (api) => {
      // Uploads are single files; each route sets its own size limit.
      await api.register(multipart, {
        limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
      });
      await registerHealthRoutes(api, {
        checkReadiness: options.health?.checkReadiness ?? checkDatabase,
      });
      await registerAuthRoutes(api, authDependencies);
      const policyCatalog =
        options.policyCatalog === undefined
          ? configuredPolicyCatalog()
          : options.policyCatalog;
      api.decorate('policyGate', createPolicyGate(policyCatalog));
      await registerPolicyRoutes(api, authDependencies, policyCatalog);
      await registerProfileRoutes(api, authDependencies, options.profiles);
      await registerProfileActivityRoutes(
        api,
        authDependencies,
        options.profileActivity,
      );
      await registerProfileSignalsRoutes(
        api,
        authDependencies,
        options.profileSignals,
      );
      await registerProfilePhotoRoutes(api, authDependencies, storage);
      await registerDataExportRoutes(api, authDependencies);
      await registerDataRequestRoutes(api, authDependencies);
      await registerTripRoutes(api, authDependencies, options.trips);
      await registerTripAlertRoutes(api, authDependencies, options.tripAlerts);
      await registerTripMembershipRoutes(
        api,
        authDependencies,
        options.tripMemberships,
      );
      await registerCommunityRoutes(api, authDependencies, options.communities);
      await registerCommunityAdminRoutes(api, authDependencies);
      await registerCommunityContentRoutes(
        api,
        authDependencies,
        options.communityContent,
      );
      await registerConnectionRoutes(
        api,
        authDependencies,
        options.connections,
      );
      await registerSafetyRoutes(
        api,
        authDependencies,
        options.safety,
        storage,
      );
      await registerModerationRoutes(api, authDependencies, storage);
      await registerMessagingRoutes(api, authDependencies, options.messaging);
      await registerNotificationRoutes(api, authDependencies);
      await registerPushDeviceRoutes(api, authDependencies);
      await registerTripRoomRoutes(api, authDependencies, options.tripRoom);
      await registerExpenseRoutes(api, authDependencies);
      await registerFinancialRoutes(api, authDependencies);
      await registerReceiptRoutes(api, authDependencies, storage);
      await registerRealtimeRoutes(
        api,
        authDependencies,
        realtime,
        options.realtimeStreams,
      );
    },
    { prefix: '/api/v1' },
  );

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof error === 'object' &&
            error !== null &&
            'statusCode' in error &&
            typeof error.statusCode === 'number' &&
            error.statusCode >= 400
          ? error.statusCode
          : 500;
    // Pino serialises errors only under `err`. Client errors are expected, so
    // they are logged without a stack at info level to keep real failures visible.
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    } else {
      request.log.info(
        {
          statusCode,
          code: error instanceof AppError ? error.code : undefined,
        },
        'Request rejected',
      );
    }

    const message =
      statusCode >= 500
        ? 'An unexpected error occurred.'
        : error instanceof Error
          ? error.message
          : 'The request could not be processed.';

    if (statusCode === 401) {
      reply.header('WWW-Authenticate', 'Bearer');
    }

    return reply.code(statusCode).send({
      error: {
        code:
          error instanceof AppError
            ? error.code
            : statusCode >= 500
              ? 'INTERNAL_SERVER_ERROR'
              : 'REQUEST_ERROR',
        message,
        requestId: request.id,
      },
    });
  });

  return app;
}
