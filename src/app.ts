import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';

import { env } from './config/env.js';
import { checkDatabase } from './database/client.js';
import { AppError } from './errors/app-error.js';
import { resolveAuthDependencies } from './modules/auth/auth.dependencies.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import type { AuthRouteDependencies } from './modules/auth/auth.types.js';
import { registerConnectionRoutes } from './modules/connections/connection.routes.js';
import type { ConnectionRouteDependencies } from './modules/connections/connection.types.js';
import { registerExpenseRoutes } from './modules/expenses/expense.routes.js';
import { registerFinancialRoutes } from './modules/expenses/financial.routes.js';
import { registerCommunityRoutes } from './modules/communities/community.routes.js';
import type { CommunityRouteDependencies } from './modules/communities/community.types.js';
import { registerCommunityContentRoutes } from './modules/communities/community-content.routes.js';
import type { CommunityContentRouteDependencies } from './modules/communities/community-content.types.js';
import {
  registerHealthRoutes,
  type HealthRouteDependencies,
} from './modules/health/health.routes.js';
import { registerMessagingRoutes } from './modules/messaging/messaging.routes.js';
import type { MessagingRouteDependencies } from './modules/messaging/messaging.types.js';
import { registerProfileRoutes } from './modules/profiles/profile.routes.js';
import type { ProfileRouteDependencies } from './modules/profiles/profile.types.js';
import { registerSafetyRoutes } from './modules/safety/safety.routes.js';
import type { SafetyRouteDependencies } from './modules/safety/safety.types.js';
import { registerTripRoomRoutes } from './modules/trip-room/trip-room.routes.js';
import type { TripRoomRouteDependencies } from './modules/trip-room/trip-room.types.js';
import {
  registerTripRoutes,
  type TripRouteDependencies,
} from './modules/trips/trip.routes.js';

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  health?: Partial<HealthRouteDependencies>;
  trips?: Partial<TripRouteDependencies>;
  auth?: Partial<AuthRouteDependencies>;
  profiles?: Partial<ProfileRouteDependencies>;
  connections?: Partial<ConnectionRouteDependencies>;
  safety?: Partial<SafetyRouteDependencies>;
  messaging?: Partial<MessagingRouteDependencies>;
  communities?: Partial<CommunityRouteDependencies>;
  communityContent?: Partial<CommunityContentRouteDependencies>;
  tripRoom?: Partial<TripRoomRouteDependencies>;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

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
      const authDependencies = resolveAuthDependencies(options.auth);
      await registerHealthRoutes(api, {
        checkReadiness: options.health?.checkReadiness ?? checkDatabase,
      });
      await registerAuthRoutes(api, authDependencies);
      await registerProfileRoutes(api, authDependencies, options.profiles);
      await registerTripRoutes(api, authDependencies, options.trips);
      await registerCommunityRoutes(api, authDependencies, options.communities);
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
      await registerSafetyRoutes(api, authDependencies, options.safety);
      await registerMessagingRoutes(api, authDependencies, options.messaging);
      await registerTripRoomRoutes(api, authDependencies, options.tripRoom);
      await registerExpenseRoutes(api, authDependencies);
      await registerFinancialRoutes(api, authDependencies);
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
    request.log.error({ error }, 'Request failed');

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
