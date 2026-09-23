import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  BlockRecord,
  ReportRecord,
  SafetyRepository,
} from '../src/modules/safety/safety.types.js';

const userId = 'a0000000-0000-4000-8000-000000000001';
const targetId = 'a0000000-0000-4000-8000-000000000002';
const outsiderId = 'a0000000-0000-4000-8000-000000000003';
const tripId = 'b0000000-0000-4000-8000-000000000001';

function user(id: string, displayName: string): AuthenticatedUser {
  return {
    id,
    displayName,
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: {
      profilePhotoStorageKey: null,
      homeCity: 'Delhi',
      homeRegion: 'Delhi NCR',
      biography: 'Travel profile used for the safety contract tests.',
      languages: ['english'],
      travelInterests: ['trekking'],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

const users: Record<string, AuthenticatedUser> = {
  'user-token': user(userId, 'Current User'),
  'target-token': user(targetId, 'Blocked User'),
  'outsider-token': user(outsiderId, 'Outsider'),
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: false };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    return { user: users[identity.subject]!, created: false };
  },
  async findFirebaseUser(subject) {
    return users[subject] ?? null;
  },
};

const blocks = new Map<string, BlockRecord>();
const reports: ReportRecord[] = [];
const visibleTargets = new Set([`USER:${targetId}`, `TRIP:${tripId}`]);

const repository: SafetyRepository = {
  async findActiveUser(id) {
    return Object.values(users).some((value) => value.id === id);
  },
  async blockUser(blockerId, blockedId, now) {
    const key = `${blockerId}:${blockedId}`;
    const existing = blocks.get(key);
    if (existing) return existing;
    const block = {
      blockerId,
      blockedId,
      createdAt: now,
      blocked: Object.values(users).find((value) => value.id === blockedId)!,
    };
    blocks.set(key, block);
    return block;
  },
  async unblockUser(blockerId, blockedId) {
    blocks.delete(`${blockerId}:${blockedId}`);
  },
  async listBlocks(blockerId, query) {
    const matching = [...blocks.values()].filter(
      (block) => block.blockerId === blockerId,
    );
    return {
      blocks: matching.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      totalItems: matching.length,
    };
  },
  async canReportTarget(reporterId, targetType, id) {
    return reporterId !== id && visibleTargets.has(`${targetType}:${id}`);
  },
  async findOpenReport(reporterId, targetType, id) {
    return (
      reports.find(
        (report) =>
          report.reporterId === reporterId &&
          report.targetType === targetType &&
          (report.reportedUserId === id ||
            report.reportedTripId === id ||
            report.reportedConnectionRequestId === id) &&
          ['SUBMITTED', 'UNDER_REVIEW'].includes(report.status),
      ) ?? null
    );
  },
  async countRecentReports(reporterId, since) {
    return reports.filter(
      (report) => report.reporterId === reporterId && report.createdAt >= since,
    ).length;
  },
  async createReport(input) {
    const now = new Date();
    const report: ReportRecord = {
      id: randomUUID(),
      reporterId: input.reporterId,
      targetType: input.targetType,
      reportedUserId: input.targetType === 'USER' ? input.targetId : null,
      reportedTripId: input.targetType === 'TRIP' ? input.targetId : null,
      reportedConnectionRequestId:
        input.targetType === 'CONNECTION_REQUEST' ? input.targetId : null,
      reportedMessageId: input.targetType === 'MESSAGE' ? input.targetId : null,
      reportedCommunityPostId:
        input.targetType === 'COMMUNITY_POST' ? input.targetId : null,
      reportedCommunityCommentId:
        input.targetType === 'COMMUNITY_COMMENT' ? input.targetId : null,
      reason: input.reason,
      details: input.details,
      status: 'SUBMITTED',
      createdAt: now,
      updatedAt: now,
    };
    reports.push(report);
    return report;
  },
  async listReports(reporterId, query) {
    const matching = reports.filter(
      (report) =>
        report.reporterId === reporterId &&
        (!query.status || report.status === query.status),
    );
    return {
      reports: matching.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      totalItems: matching.length,
    };
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  safety: { repository },
});

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('safety HTTP contract', () => {
  it('rejects self-blocking and hides unknown users', async () => {
    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/block`,
      headers: headers('user-token'),
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${randomUUID()}/block`,
      headers: headers('user-token'),
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF_BLOCK');
    expect(unknown.statusCode).toBe(404);
  });

  it('blocks idempotently, scopes the list, and unblocks idempotently', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${targetId}/block`,
      headers: headers('user-token'),
    });
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${targetId}/block`,
      headers: headers('user-token'),
    });
    const ownList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/blocked-users',
      headers: headers('user-token'),
    });
    const outsiderList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/blocked-users',
      headers: headers('outsider-token'),
    });
    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    expect(ownList.json().data).toHaveLength(1);
    expect(ownList.json().data[0].user.id).toBe(targetId);
    expect(outsiderList.json().data).toHaveLength(0);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const unblocked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${targetId}/block`,
        headers: headers('user-token'),
      });
      expect(unblocked.statusCode).toBe(204);
    }
  });

  it('requires useful details for OTHER reports', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('user-token'),
      payload: {
        targetType: 'USER',
        targetId,
        reason: 'OTHER',
        details: 'short',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REPORT_DETAILS_REQUIRED');
  });

  it('creates a report, prevents unresolved duplicates, and scopes listing', async () => {
    const payload = {
      targetType: 'TRIP',
      targetId: tripId,
      reason: 'COMMERCIAL_TOUR_SPAM',
      details: 'This appears to be a commercial tour advertisement.',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('user-token'),
      payload,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('user-token'),
      payload,
    });
    const ownList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reports?status=SUBMITTED',
      headers: headers('user-token'),
    });
    const outsiderList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/reports',
      headers: headers('outsider-token'),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.target).toEqual({ type: 'TRIP', id: tripId });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('REPORT_ALREADY_SUBMITTED');
    expect(ownList.json().data).toHaveLength(1);
    expect(outsiderList.json().data).toHaveLength(0);
  });

  it('rejects self-reports and targets outside the reporter visibility', async () => {
    const cases = [
      { targetType: 'USER', targetId: userId, expected: 'SELF_REPORT' },
      {
        targetType: 'CONNECTION_REQUEST',
        targetId: randomUUID(),
        expected: 'REPORT_TARGET_NOT_FOUND',
      },
    ];
    for (const testCase of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: headers('user-token'),
        payload: {
          targetType: testCase.targetType,
          targetId: testCase.targetId,
          reason: 'HARASSMENT',
        },
      });
      expect(response.json().error.code).toBe(testCase.expected);
    }
  });

  it('maps a concurrent duplicate database conflict to a safe 409', async () => {
    visibleTargets.add(`USER:${targetId}`);
    const originalCreate = repository.createReport;
    repository.createReport = async () => {
      throw new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.12.0',
      });
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('user-token'),
      payload: {
        targetType: 'USER',
        targetId,
        reason: 'IMPERSONATION',
      },
    });
    repository.createReport = originalCreate;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPORT_ALREADY_SUBMITTED');
  });
});
