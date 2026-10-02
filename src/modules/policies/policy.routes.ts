import type { PolicyType } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  acceptPolicyVersion,
  listPolicyAcceptances,
} from './policy.repository.js';
import {
  currentAcceptanceStatus,
  policyTypes,
  publicPolicies,
  requireCurrentPolicy,
  type PolicyCatalog,
} from './policy.service.js';

interface AcceptPolicyBody {
  policyType: PolicyType;
  version: string;
  accepted: true;
}

const policySchema = {
  type: 'object',
  required: ['policyType', 'version', 'url'],
  properties: {
    policyType: { type: 'string', enum: policyTypes },
    version: { type: 'string' },
    url: { type: 'string', format: 'uri' },
  },
} as const;

const catalogResponse = {
  type: 'object',
  required: ['configured', 'data'],
  properties: {
    configured: { type: 'boolean' },
    data: { type: 'array', items: policySchema },
  },
} as const;

const acceptanceSchema = {
  type: 'object',
  required: ['policyType', 'version', 'acceptedAt'],
  properties: {
    policyType: { type: 'string', enum: policyTypes },
    version: { type: 'string' },
    acceptedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export async function registerPolicyRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
  catalog: PolicyCatalog,
): Promise<void> {
  app.get(
    '/policies',
    {
      schema: {
        tags: ['Policies'],
        summary: 'List the current approved policy versions and document links',
        response: { 200: catalogResponse },
      },
    },
    async () => ({
      configured: catalog !== null,
      data: publicPolicies(catalog),
    }),
  );

  app.get(
    '/me/policy-acceptances',
    {
      schema: {
        tags: ['Policies'],
        summary:
          'Check whether the current account accepted each current policy',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['configured', 'data'],
            properties: {
              configured: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  required: [
                    'policyType',
                    'version',
                    'url',
                    'acceptedAt',
                    'needsAcceptance',
                  ],
                  properties: {
                    ...policySchema.properties,
                    acceptedAt: {
                      anyOf: [
                        { type: 'string', format: 'date-time' },
                        { type: 'null' },
                      ],
                    },
                    needsAcceptance: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const acceptances = await listPolicyAcceptances(user.id);
      return {
        configured: catalog !== null,
        data: currentAcceptanceStatus(catalog, acceptances),
      };
    },
  );

  app.post<{ Body: AcceptPolicyBody }>(
    '/me/policy-acceptances',
    {
      schema: {
        tags: ['Policies'],
        summary: 'Explicitly accept one current policy version',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['policyType', 'version', 'accepted'],
          properties: {
            policyType: { type: 'string', enum: policyTypes },
            version: { type: 'string', minLength: 1, maxLength: 50 },
            accepted: { type: 'boolean', enum: [true] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: acceptanceSchema },
          },
        },
      },
    },
    async (request) => {
      const user = await authenticateRequest(request, auth);
      const { policyType, version } = request.body;
      requireCurrentPolicy(catalog, policyType, version);
      const acceptance = await acceptPolicyVersion(
        user.id,
        policyType,
        version,
      );
      return {
        data: {
          ...acceptance,
          acceptedAt: acceptance.acceptedAt.toISOString(),
        },
      };
    },
  );
}
