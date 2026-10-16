import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import { requireAdmin } from '../moderation/moderation.repository.js';
import {
  metricWindow,
  summarizeMetricCounts,
} from './admin-metrics.service.js';
import {
  accountMetricStatuses,
  connectionMetricStatuses,
  reportMetricStatuses,
  tripMetricStatuses,
  type AdminMetricsRepository,
} from './admin-metrics.types.js';

export const prismaAdminMetricsRepository: AdminMetricsRepository = {
  readOverview(userId, days) {
    return database.$transaction(
      async (tx) => {
        // No audit/event/analytics writes or persisted copies of these aggregates.
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        // Authorize using the same snapshot as the counts, not client claims,
        // a cached role or a role check performed in a different transaction.
        const actor = await tx.user.findUnique({
          where: { id: userId },
          select: { status: true, staffRole: true, deletedAt: true },
        });
        if (!actor || actor.status !== 'ACTIVE' || actor.deletedAt) {
          throw new AppError(
            403,
            'ACCOUNT_DISABLED',
            'This account cannot access administrator metrics.',
          );
        }
        requireAdmin(actor.staffRole);
        const [clock] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT CURRENT_TIMESTAMP AS now`;
        if (!clock) throw new Error('Database clock unavailable.');
        const window = metricWindow(days, clock.now);
        const createdAt = {
          gte: new Date(window.from),
          lt: new Date(window.to),
        };
        const accountWhere = {
          status: { in: [...accountMetricStatuses] },
          deletedAt: null,
        };
        // Sequential queries avoid parallel operations on a single pg connection.
        const accountRows = await tx.user.groupBy({
          by: ['status'],
          where: accountWhere,
          _count: { _all: true },
        });
        const accounts = summarizeMetricCounts(
          accountMetricStatuses,
          accountRows,
          await tx.user.count({ where: { ...accountWhere, createdAt } }),
        );
        const tripRows = await tx.trip.groupBy({
          by: ['status'],
          _count: { _all: true },
        });
        const trips = summarizeMetricCounts(
          tripMetricStatuses,
          tripRows,
          await tx.trip.count({ where: { createdAt } }),
        );
        const connectionRows = await tx.connectionRequest.groupBy({
          by: ['status'],
          _count: { _all: true },
        });
        const connectionRequests = summarizeMetricCounts(
          connectionMetricStatuses,
          connectionRows,
          await tx.connectionRequest.count({ where: { createdAt } }),
        );
        const reportRows = await tx.report.groupBy({
          by: ['status'],
          _count: { _all: true },
        });
        const reports = summarizeMetricCounts(
          reportMetricStatuses,
          reportRows,
          await tx.report.count({ where: { createdAt } }),
        );
        return {
          generatedAt: window.to,
          window,
          accounts,
          trips,
          connectionRequests,
          reports: {
            ...reports,
            open: reports.byStatus.SUBMITTED + reports.byStatus.UNDER_REVIEW,
          },
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      },
    );
  },
};
