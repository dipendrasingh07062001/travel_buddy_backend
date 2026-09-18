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
import {
  registerHealthRoutes,
  type HealthRouteDependencies,
} from './modules/health/health.routes.js';
import { registerProfileRoutes } from './modules/profiles/profile.routes.js';
import type { ProfileRouteDependencies } from './modules/profiles/profile.types.js';
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
