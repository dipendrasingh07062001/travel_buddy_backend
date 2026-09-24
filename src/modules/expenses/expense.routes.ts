import type { FastifyInstance } from 'fastify';

import { authenticateRequest } from '../auth/auth.service.js';
import type { AuthRouteDependencies } from '../auth/auth.types.js';
import { EXPENSE_NOTICE, presentExpense } from './expense.presenter.js';
import {
  createExpense,
  getBalances,
  getExpense,
  listExpenses,
  updateExpense,
  voidExpense,
} from './expense.repository.js';
import { prepareExpense } from './expense.service.js';
import type { ExpenseBody, UpdateExpenseBody } from './expense.types.js';

const tripParams = {
  type: 'object',
  required: ['tripId'],
  properties: { tripId: { type: 'string', format: 'uuid' } },
} as const;
const expenseParams = {
  type: 'object',
  required: ['expenseId'],
  properties: { expenseId: { type: 'string', format: 'uuid' } },
} as const;
const expenseFields = {
  description: { type: 'string', minLength: 2, maxLength: 200 },
  category: {
    type: 'string',
    enum: [
      'ACCOMMODATION',
      'TRANSPORT',
      'FOOD',
      'FUEL',
      'ACTIVITY',
      'SHOPPING',
      'OTHER',
    ],
  },
  amountPaise: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
  paidByUserId: { type: 'string', format: 'uuid' },
  splitMethod: { type: 'string', enum: ['EQUAL', 'CUSTOM'] },
  expenseDate: { type: 'string', format: 'date' },
  participants: {
    type: 'array',
    minItems: 1,
    maxItems: 30,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['userId'],
      properties: {
        userId: { type: 'string', format: 'uuid' },
        amountPaise: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
      },
    },
  },
} as const;
const requiredExpenseFields = [
  'description',
  'category',
  'amountPaise',
  'paidByUserId',
  'splitMethod',
  'participants',
] as const;
const person = {
  type: 'object',
  required: ['id', 'displayName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;
const expenseView = {
  type: 'object',
  required: [
    'id',
    'tripId',
    'description',
    'category',
    'amountPaise',
    'currency',
    'splitMethod',
    'expenseDate',
    'status',
    'version',
    'createdBy',
    'paidBy',
    'shares',
    'createdAt',
    'updatedAt',
    'voidedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tripId: { type: 'string', format: 'uuid' },
    description: { type: 'string' },
    category: { type: 'string' },
    amountPaise: { type: 'integer' },
    currency: { type: 'string' },
    splitMethod: { type: 'string' },
    expenseDate: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['ACTIVE', 'VOIDED'] },
    version: { type: 'integer' },
    createdBy: person,
    paidBy: person,
    shares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['user', 'amountPaise'],
        properties: { user: person, amountPaise: { type: 'integer' } },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    voidedAt: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;
const expenseResponse = {
  type: 'object',
  required: ['data', 'notice'],
  properties: { data: expenseView, notice: { type: 'string' } },
} as const;

export async function registerExpenseRoutes(
  app: FastifyInstance,
  auth: AuthRouteDependencies,
): Promise<void> {
  app.post<{ Params: { tripId: string }; Body: ExpenseBody }>(
    '/trips/:tripId/expenses',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Expenses'],
        summary: 'Record a private shared trip expense',
        security: [{ bearerAuth: [] }],
        params: tripParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: requiredExpenseFields,
          properties: expenseFields,
        },
        response: { 201: expenseResponse },
      },
    },
    async (request, reply) => {
      const actor = await authenticateRequest(request, auth);
      const expense = await createExpense(
        request.params.tripId,
        actor.id,
        prepareExpense(request.body),
      );
      return reply
        .code(201)
        .send({ data: presentExpense(expense), notice: EXPENSE_NOTICE });
    },
  );

  app.get<{
    Params: { tripId: string };
    Querystring: { page?: number; pageSize?: number };
  }>(
    '/trips/:tripId/expenses',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'List the private trip expense ledger',
        security: [{ bearerAuth: [] }],
        params: tripParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination', 'notice'],
            properties: {
              data: { type: 'array', items: expenseView },
              pagination: {
                type: 'object',
                required: ['page', 'pageSize', 'total'],
                properties: {
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
              notice: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const page = request.query.page ?? 1;
      const pageSize = request.query.pageSize ?? 20;
      const result = await listExpenses(
        request.params.tripId,
        actor.id,
        page,
        pageSize,
      );
      return {
        data: result.expenses.map(presentExpense),
        pagination: { page, pageSize, total: result.total },
        notice: EXPENSE_NOTICE,
      };
    },
  );

  app.get<{ Params: { tripId: string } }>(
    '/trips/:tripId/expenses/balances',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Calculate paid, owed and net balances from active expenses',
        security: [{ bearerAuth: [] }],
        params: tripParams,
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      return {
        data: await getBalances(request.params.tripId, actor.id),
        notice: EXPENSE_NOTICE,
      };
    },
  );

  app.get<{ Params: { expenseId: string } }>(
    '/expenses/:expenseId',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'View an expense and its revision history',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const result = await getExpense(request.params.expenseId, actor.id);
      return {
        data: {
          ...presentExpense(result.expense),
          revisions: result.revisions.map((revision) => ({
            ...revision,
            createdAt: revision.createdAt.toISOString(),
          })),
        },
        notice: EXPENSE_NOTICE,
      };
    },
  );

  app.put<{ Params: { expenseId: string }; Body: UpdateExpenseBody }>(
    '/expenses/:expenseId',
    {
      schema: {
        tags: ['Expenses'],
        summary:
          'Replace an expense as its creator, preserving an audit revision',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: [...requiredExpenseFields, 'expectedVersion'],
          properties: {
            ...expenseFields,
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
        response: { 200: expenseResponse },
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const expense = await updateExpense(
        request.params.expenseId,
        actor.id,
        request.body.expectedVersion,
        prepareExpense(request.body),
      );
      return { data: presentExpense(expense), notice: EXPENSE_NOTICE };
    },
  );

  app.delete<{
    Params: { expenseId: string };
    Body: { expectedVersion: number };
  }>(
    '/expenses/:expenseId',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Void an owned expense without deleting its history',
        security: [{ bearerAuth: [] }],
        params: expenseParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: { expectedVersion: { type: 'integer', minimum: 1 } },
        },
        response: { 200: expenseResponse },
      },
    },
    async (request) => {
      const actor = await authenticateRequest(request, auth);
      const expense = await voidExpense(
        request.params.expenseId,
        actor.id,
        request.body.expectedVersion,
      );
      return { data: presentExpense(expense), notice: EXPENSE_NOTICE };
    },
  );
}
