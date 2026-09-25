import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import {
  decideSettlement,
  flagExpense,
  getMyFinancialRecords,
  listDisputes,
  listSettlements,
  recordSettlement,
  withdrawDispute,
} from './financial.repository.js';
import { EXPENSE_NOTICE } from './expense.presenter.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const tripParams = {
  type: 'object',
  required: ['tripId'],
  properties: { tripId: uuid },
} as const;
const expenseParams = {
  type: 'object',
  required: ['expenseId'],
  properties: { expenseId: uuid },
} as const;
const settlementParams = {
  type: 'object',
  required: ['settlementId'],
  properties: { settlementId: uuid },
} as const;
const disputeParams = {
  type: 'object',
  required: ['disputeId'],
  properties: { disputeId: uuid },
} as const;
const pagination = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const;
const SETTLEMENT_NOTICE =
  'This records a payment claimed by a member. Money moves outside Travel Buddy. Pending records do not change balances; only the receiver can confirm receipt. Never share passwords, OTPs, UPI PINs or card credentials.';

function presentSettlement(
  record: Awaited<ReturnType<typeof recordSettlement>>,
) {
  return {
    id: record.id,
    tripId: record.tripId,
    payer: record.payer,
    receiver: record.receiver,
    amountPaise: record.amountPaise,
    currency: record.currency.trim(),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
  };
}

function presentDispute(record: Awaited<ReturnType<typeof flagExpense>>) {
  return {
    id: record.id,
    expenseId: record.expenseId,
    reporter: record.reporter,
    reason: record.reason,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
  };
}

export async function registerFinancialRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.get<{
    Params: { tripId: string };
    Querystring: { page?: number; pageSize?: number };
  }>(
    '/trips/:tripId/expenses/me',
    {
      schema: {
        tags: ['Expenses'],
        summary:
          'View only your own balance and expense lines, including after leaving a trip',
        security: [{ bearerAuth: [] }],
        params: tripParams,
        querystring: pagination,
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return {
        data: await getMyFinancialRecords(
          request.params.tripId,
          actor.id,
          request.query.page ?? 1,
          request.query.pageSize ?? 20,
        ),
        notice: EXPENSE_NOTICE,
      };
    },
  );

  app.post<{ Params: { expenseId: string }; Body: { reason: string } }>(
    '/expenses/:expenseId/disputes',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Expenses'],
        summary: 'Flag an expense that affects your own balance',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 2, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const dispute = await flagExpense(
        request.params.expenseId,
        actor.id,
        request.body.reason,
      );
      return reply.code(201).send({
        data: presentDispute(dispute),
        notice:
          'A dispute is a member-reported flag. Travel Buddy does not decide who is correct.',
      });
    },
  );

  app.get<{ Params: { expenseId: string } }>(
    '/expenses/:expenseId/disputes',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'List expense dispute flags visible to you',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const records = await listDisputes(request.params.expenseId, actor.id);
      return { data: records.map(presentDispute) };
    },
  );

  app.post<{ Params: { disputeId: string } }>(
    '/expense-disputes/:disputeId/withdraw',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Withdraw your own dispute flag',
        security: [{ bearerAuth: [] }],
        params: disputeParams,
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return {
        data: presentDispute(
          await withdrawDispute(request.params.disputeId, actor.id),
        ),
      };
    },
  );

  app.post<{
    Params: { tripId: string };
    Body: { receiverId: string; amountPaise: number };
  }>(
    '/trips/:tripId/settlements',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Expenses'],
        summary: 'Record an external payment for the receiver to confirm',
        security: [{ bearerAuth: [] }],
        params: tripParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['receiverId', 'amountPaise'],
          properties: {
            receiverId: uuid,
            amountPaise: {
              type: 'integer',
              minimum: 1,
              maximum: 1_000_000_000,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const record = await recordSettlement(
        request.params.tripId,
        actor.id,
        request.body.receiverId,
        request.body.amountPaise,
      );
      return reply
        .code(201)
        .send({ data: presentSettlement(record), notice: SETTLEMENT_NOTICE });
    },
  );

  for (const [path, ownOnly] of [
    ['/trips/:tripId/settlements', false],
    ['/trips/:tripId/settlements/me', true],
  ] as const) {
    app.get<{
      Params: { tripId: string };
      Querystring: { page?: number; pageSize?: number };
    }>(
      path,
      {
        schema: {
          tags: ['Expenses'],
          summary: ownOnly
            ? 'View only settlements involving you, including after departure'
            : 'View the active trip members’ settlement ledger',
          security: [{ bearerAuth: [] }],
          params: tripParams,
          querystring: pagination,
        },
      },
      async (request) => {
        const actor = await authenticateRequest(request, auth);
        const result = await listSettlements(
          request.params.tripId,
          actor.id,
          ownOnly,
          request.query.page ?? 1,
          request.query.pageSize ?? 20,
        );
        return {
          data: result.records.map(presentSettlement),
          pagination: result.pagination,
          notice: SETTLEMENT_NOTICE,
        };
      },
    );
  }

  for (const [action, decision] of [
    ['confirm', 'CONFIRMED'],
    ['reject', 'REJECTED'],
    ['cancel', 'CANCELLED'],
  ] as const) {
    app.post<{ Params: { settlementId: string } }>(
      `/settlements/:settlementId/${action}`,
      {
        schema: {
          tags: ['Expenses'],
          summary: `${action} a pending external settlement record`,
          security: [{ bearerAuth: [] }],
          params: settlementParams,
        },
      },
      async (request) => {
        const actor = await authenticateRequest(request, auth);
        return {
          data: presentSettlement(
            await decideSettlement(
              request.params.settlementId,
              actor.id,
              decision,
            ),
          ),
          notice: SETTLEMENT_NOTICE,
        };
      },
    );
  }
}
