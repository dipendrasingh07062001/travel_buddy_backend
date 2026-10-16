import type {
  ConnectionRequestStatus,
  ReportStatus,
  TripStatus,
  UserStatus,
} from '../../generated/prisma/client.js';

export const metricWindows = [7, 30, 90] as const;
export type MetricWindowDays = (typeof metricWindows)[number];
export const accountMetricStatuses = [
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
] as const satisfies readonly UserStatus[];
export const tripMetricStatuses = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'FULL',
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly TripStatus[];
export const connectionMetricStatuses = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
  'BLOCKED',
] as const satisfies readonly ConnectionRequestStatus[];
export const reportMetricStatuses = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTIONED',
  'DISMISSED',
] as const satisfies readonly ReportStatus[];

export interface MetricCounts<Status extends string> {
  total: number;
  byStatus: Record<Status, number>;
  createdInWindow: number;
}

export interface AdminMetricsOverview {
  generatedAt: string;
  window: { days: MetricWindowDays; from: string; to: string };
  accounts: MetricCounts<(typeof accountMetricStatuses)[number]>;
  trips: MetricCounts<TripStatus>;
  connectionRequests: MetricCounts<ConnectionRequestStatus>;
  reports: MetricCounts<ReportStatus> & { open: number };
}

export interface AdminMetricsRepository {
  readOverview(
    userId: string,
    days: MetricWindowDays,
  ): Promise<AdminMetricsOverview>;
}

export interface AdminMetricsDependencies {
  repository: AdminMetricsRepository;
}
