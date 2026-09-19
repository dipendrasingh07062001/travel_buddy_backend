import type {
  Prisma,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from '@prisma/client';

export const blockedUserSelect = {
  id: true,
  displayName: true,
  birthDate: true,
  status: true,
  createdAt: true,
  profile: {
    select: {
      profilePhotoStorageKey: true,
      homeCity: true,
      homeRegion: true,
      biography: true,
      languages: true,
      travelInterests: true,
      pastTripsVisibility: true,
      communityActivityVisibility: true,
    },
  },
} satisfies Prisma.UserSelect;

export const blockInclude = {
  blocked: { select: blockedUserSelect },
} satisfies Prisma.UserBlockInclude;

export type BlockRecord = Prisma.UserBlockGetPayload<{
  include: typeof blockInclude;
}>;

export type ReportRecord = Prisma.ReportGetPayload<Record<string, never>>;

export interface ListBlocksQuery {
  page: number;
  pageSize: number;
}

export interface ListReportsQuery {
  status?: ReportStatus;
  page: number;
  pageSize: number;
}

export interface CreateReportInput {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
}

export interface SafetyRepository {
  findActiveUser(userId: string): Promise<boolean>;
  blockUser(
    blockerId: string,
    blockedId: string,
    now: Date,
  ): Promise<BlockRecord>;
  unblockUser(blockerId: string, blockedId: string): Promise<void>;
  listBlocks(
    blockerId: string,
    query: ListBlocksQuery,
  ): Promise<{ blocks: BlockRecord[]; totalItems: number }>;
  canReportTarget(
    reporterId: string,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<boolean>;
  findOpenReport(
    reporterId: string,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<ReportRecord | null>;
  countRecentReports(reporterId: string, since: Date): Promise<number>;
  createReport(input: CreateReportInput): Promise<ReportRecord>;
  listReports(
    reporterId: string,
    query: ListReportsQuery,
  ): Promise<{ reports: ReportRecord[]; totalItems: number }>;
}

export interface SafetyRouteDependencies {
  repository: SafetyRepository;
}
