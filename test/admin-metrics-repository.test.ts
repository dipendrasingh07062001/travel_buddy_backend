import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '../src/database/client.js';
import { prismaAdminMetricsRepository } from '../src/modules/admin-metrics/admin-metrics.repository.js';

const mocks = vi.hoisted(() => {
  const delegate = () => ({ groupBy: vi.fn(), count: vi.fn() });
  return {
    transaction: vi.fn(),
    tx: {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      user: { ...delegate(), findUnique: vi.fn() },
      trip: delegate(),
      connectionRequest: delegate(),
      report: delegate(),
    },
  };
});
vi.mock('../src/database/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  database: { $transaction: mocks.transaction },
}));
const now = new Date('2026-10-16T12:34:56.789Z');
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(
    async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx),
  );
  mocks.tx.$executeRaw.mockResolvedValue(0);
  mocks.tx.$queryRaw.mockResolvedValue([{ now }]);
  mocks.tx.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    staffRole: 'ADMIN',
    deletedAt: null,
  });
  for (const delegate of [
    mocks.tx.user,
    mocks.tx.trip,
    mocks.tx.connectionRequest,
    mocks.tx.report,
  ]) {
    delegate.groupBy.mockResolvedValue([]);
    delegate.count.mockResolvedValue(0);
  }
});
const read = () => prismaAdminMetricsRepository.readOverview('admin-id', 30);

describe('admin metrics snapshot authorization and query boundaries', () => {
  it('uses a read-only repeatable-read transaction with bounded query times', async () => {
    await read();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      timeout: 15000,
    });
    const sql = mocks.tx.$executeRaw.mock.calls.map(([parts]) =>
      (parts as TemplateStringsArray).join(''),
    );
    expect(sql).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '5s'",
    ]);
    expect(mocks.tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'admin-id' },
      select: { status: true, staffRole: true, deletedAt: true },
    });
  });
  it.each(['USER', 'MODERATOR'])(
    'does not load counts for the local %s role',
    async (staffRole) => {
      mocks.tx.user.findUnique.mockResolvedValue({
        status: 'ACTIVE',
        staffRole,
        deletedAt: null,
      });
      await expect(read()).rejects.toMatchObject({
        statusCode: 403,
        code: 'ADMIN_ONLY',
      });
      expect(mocks.tx.user.groupBy).not.toHaveBeenCalled();
      expect(mocks.tx.trip.groupBy).not.toHaveBeenCalled();
      expect(mocks.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { status: 'SUSPENDED', staffRole: 'ADMIN', deletedAt: null },
    { status: 'PENDING_DELETION', staffRole: 'ADMIN', deletedAt: null },
    { status: 'DELETED', staffRole: 'ADMIN', deletedAt: now },
    { status: 'ACTIVE', staffRole: 'ADMIN', deletedAt: now },
  ])('rechecks disabled/missing local administrator state', async (actor) => {
    mocks.tx.user.findUnique.mockResolvedValue(actor);
    await expect(read()).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_DISABLED',
    });
    expect(mocks.tx.user.groupBy).not.toHaveBeenCalled();
  });
  it('uses database time and lower-inclusive, upper-exclusive bounds for all creation counts', async () => {
    const response = await read();
    expect(response.generatedAt).toBe(now.toISOString());
    expect(response.window).toEqual({
      days: 30,
      from: '2026-09-16T12:34:56.789Z',
      to: now.toISOString(),
    });
    const createdAt = { gte: new Date(response.window.from), lt: now };
    expect(mocks.tx.user.count).toHaveBeenCalledWith({
      where: {
        status: { in: ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION'] },
        deletedAt: null,
        createdAt,
      },
    });
    for (const delegate of [
      mocks.tx.trip,
      mocks.tx.connectionRequest,
      mocks.tx.report,
    ])
      expect(delegate.count).toHaveBeenCalledWith({ where: { createdAt } });
  });
  it('computes open reports from current submitted and under-review status counts only', async () => {
    mocks.tx.report.groupBy.mockResolvedValue([
      { status: 'SUBMITTED', _count: { _all: 3 } },
      { status: 'UNDER_REVIEW', _count: { _all: 2 } },
      { status: 'ACTIONED', _count: { _all: 8 } },
      { status: 'DISMISSED', _count: { _all: 4 } },
    ]);
    expect((await read()).reports).toMatchObject({ total: 17, open: 5 });
  });
  it('fails closed if the database clock cannot be read', async () => {
    mocks.tx.$queryRaw.mockResolvedValue([]);
    await expect(read()).rejects.toThrow('Database clock unavailable.');
    expect(mocks.tx.user.groupBy).not.toHaveBeenCalled();
  });
});
