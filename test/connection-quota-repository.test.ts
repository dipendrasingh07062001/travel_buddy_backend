import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../src/database/client.js';
import { prismaConnectionRepository } from '../src/modules/connections/connection.repository.js';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  notify: vi.fn(),
  tx: {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    accountRestriction: { findFirst: vi.fn() },
    connectionRequest: { count: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('../src/database/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  databaseSchema: 'quota"schema',
  database: { $transaction: mocks.transaction },
}));
vi.mock('../src/modules/notifications/notification.repository.js', () => ({
  createNotifications: mocks.notify,
}));

const now = new Date('2026-10-16T12:34:56.789Z');
const input = {
  requesterId: '80000000-0000-4000-8000-000000000002',
  recipientId: '80000000-0000-4000-8000-000000000001',
  tripId: '90000000-0000-4000-8000-000000000001',
  relatedTripId: null,
  message: 'Please consider this request to join your travel plan.',
};
const request = { ...input, id: 'request-id', createdAt: now };
const create = () => prismaConnectionRepository.createWithinDailyLimit(input);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(
    async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx),
  );
  mocks.tx.$queryRaw
    .mockResolvedValueOnce([{ id: input.requesterId }])
    .mockResolvedValueOnce([{ now }]);
  mocks.tx.accountRestriction.findFirst.mockResolvedValue(null);
  mocks.tx.connectionRequest.count.mockResolvedValue(19);
  mocks.tx.connectionRequest.create.mockResolvedValue(request);
});

describe('atomic connection-request quota repository contract', () => {
  it('locks the requester before reading a fresh database clock and counting', async () => {
    await create();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 15000,
    });
    const [lock, clock] = mocks.tx.$queryRaw.mock.calls;
    expect((lock![0] as TemplateStringsArray).join('')).toBe(
      'SELECT id FROM  WHERE id = ::uuid FOR NO KEY UPDATE',
    );
    expect(lock![1]).toMatchObject({ sql: '"quota""schema"."users"' });
    expect(lock![2]).toBe(input.requesterId);
    expect((clock![0] as TemplateStringsArray).join('')).toContain(
      'clock_timestamp()',
    );
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.tx.connectionRequest.count.mock.invocationCallOrder[0]!,
    );
    expect(mocks.tx.connectionRequest.count).toHaveBeenCalledWith({
      where: {
        requesterId: input.requesterId,
        createdAt: { gte: new Date('2026-10-15T12:34:56.789Z') },
      },
    });
    expect(
      (mocks.tx.$executeRaw.mock.calls[0]![0] as TemplateStringsArray).join(''),
    ).toBe("SET LOCAL statement_timeout = '5s'");
  });

  it('inserts request 20 and its notification in the same transaction and clock', async () => {
    expect(await create()).toEqual(request);
    expect(mocks.tx.connectionRequest.create).toHaveBeenCalledWith({
      data: { ...input, createdAt: now },
      include: expect.any(Object),
    });
    expect(mocks.notify).toHaveBeenCalledWith(mocks.tx, {
      recipientIds: [input.recipientId],
      type: 'CONNECTION_REQUEST_RECEIVED',
      eventKey: 'connection-request:request-id:received',
      sourceId: 'request-id',
      tripId: input.tripId,
      actorId: input.requesterId,
      createdAt: now,
    });
  });

  it.each([20, 21])(
    'does not write anything when %i requests already count',
    async (count) => {
      mocks.tx.connectionRequest.count.mockResolvedValue(count);
      expect(await create()).toBeNull();
      expect(mocks.tx.connectionRequest.create).not.toHaveBeenCalled();
      expect(mocks.notify).not.toHaveBeenCalled();
    },
  );

  it('fails closed without a database clock', async () => {
    mocks.tx.$queryRaw.mockReset();
    mocks.tx.$queryRaw.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    await expect(create()).rejects.toThrow('Database clock unavailable.');
    expect(mocks.tx.connectionRequest.count).not.toHaveBeenCalled();
    expect(mocks.tx.connectionRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a restricted requester before counting or writing', async () => {
    const endsAt = new Date('2026-10-20T00:00:00.000Z');
    mocks.tx.accountRestriction.findFirst.mockResolvedValue({ endsAt });
    await expect(create()).rejects.toMatchObject({
      statusCode: 403,
      code: 'FEATURE_RESTRICTED',
    });
    expect(mocks.tx.accountRestriction.findFirst).toHaveBeenCalledWith({
      where: {
        userId: input.requesterId,
        feature: 'CONNECTION_REQUESTS',
        liftedAt: null,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { endsAt: true },
    });
    expect(mocks.tx.connectionRequest.count).not.toHaveBeenCalled();
    expect(mocks.tx.connectionRequest.create).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('propagates notification failure so the database transaction rolls back', async () => {
    mocks.notify.mockRejectedValue(new Error('Notification unavailable'));
    await expect(create()).rejects.toThrow('Notification unavailable');
  });
});
