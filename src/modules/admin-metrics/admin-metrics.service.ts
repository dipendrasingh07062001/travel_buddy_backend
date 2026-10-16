import type { MetricCounts, MetricWindowDays } from './admin-metrics.types.js';

/** Rolling UTC instants, not the last N local-calendar dates or an engagement metric. */
export function metricWindow(days: MetricWindowDays, now: Date) {
  return {
    days,
    from: new Date(now.getTime() - days * 86_400_000).toISOString(),
    to: now.toISOString(),
  };
}

export function summarizeMetricCounts<Status extends string>(
  statuses: readonly Status[],
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
  createdInWindow: number,
): MetricCounts<Status> {
  const byStatus = Object.fromEntries(
    statuses.map((status) => [
      status,
      rows.find((row) => row.status === status)?._count._all ?? 0,
    ]),
  ) as Record<Status, number>;
  return {
    total: statuses.reduce((sum, status) => sum + byStatus[status], 0),
    byStatus,
    createdInWindow,
  };
}
