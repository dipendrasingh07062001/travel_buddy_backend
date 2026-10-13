import { randomUUID } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import type { TokenVerifier } from '../src/modules/auth/auth.types.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { multipartFile } from './helpers/multipart.js';

const run = randomUUID();
const roles = ['owner', 'reporter', 'moderator', 'admin', 'plain'] as const;
type Role = (typeof roles)[number];
const userIds = {} as Record<Role, string>;

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return {
      subject: `photo-moderation-${token}-${run}`,
      emailVerified: false,
    };
  },
};
const storage = new MemoryStorage();
const app = buildApp({ logger: false, auth: { tokenVerifier }, storage });

function api(
  method: 'GET' | 'POST',
  url: string,
  role: Role,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${role}` },
    ...(payload && { payload }),
  });
}

async function uploadPhoto(role: Role, color: string) {
  const content = await sharp({
    create: { width: 600, height: 600, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  const body = multipartFile('photo', content, 'image/jpeg');
  const response = await app.inject({
    method: 'PUT',
    url: '/api/v1/me/profile-photo',
    headers: { authorization: `Bearer ${role}`, ...body.headers },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(200);
  return currentPhotoKey(role);
}

async function currentPhotoKey(role: Role) {
  const profile = await database.userProfile.findUnique({
    where: { userId: userIds[role] },
    select: { profilePhotoStorageKey: true },
  });
  return profile?.profilePhotoStorageKey ?? null;
}

const reportPhoto = (target: Role) =>
  api('POST', '/reports', 'reporter', {
    targetType: 'PROFILE_PHOTO',
    targetId: userIds[target],
    reason: 'HARASSMENT',
  });

const reason = 'Photo breaks the community standards on harassment.';

async function claimAndResolve(reportId: string) {
  const claimed = await api(
    'POST',
    `/admin/reports/${reportId}/start-review`,
    'moderator',
  );
  expect(claimed.statusCode).toBe(200);
  return api('POST', `/admin/reports/${reportId}/resolve`, 'moderator', {
    resolution: 'REMOVE_CONTENT',
    reason,
  });
}

const removalNotifications = (role: Role) =>
  database.notification.count({
    where: { recipientId: userIds[role], type: 'PROFILE_PHOTO_REMOVED' },
  });

beforeAll(async () => {
  await app.ready();
  for (const role of roles) {
    const response = await api('POST', '/auth/bootstrap', role);
    userIds[role] = response.json().data.id as string;
  }
  await database.user.update({
    where: { id: userIds.moderator },
    data: { staffRole: 'MODERATOR' },
  });
  await database.user.update({
    where: { id: userIds.admin },
    data: { staffRole: 'ADMIN' },
  });
});

afterAll(async () => {
  await app.close();
  const ids = Object.values(userIds);
  await database.moderationAction.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
  });
  await database.report.deleteMany({
    where: {
      OR: [{ reporterId: { in: ids } }, { reportedUserId: { in: ids } }],
    },
  });
  await database.user.deleteMany({ where: { id: { in: ids } } });
  await database.$disconnect();
});

describe('reporting a profile photo', () => {
  it('records the reported photo and keeps a private copy as evidence', async () => {
    const photoKey = await uploadPhoto('owner', '#aa3333');
    const response = await reportPhoto('owner');

    expect(response.statusCode).toBe(201);
    expect(response.json().data.target).toEqual({
      type: 'PROFILE_PHOTO',
      id: userIds.owner,
    });
    const report = await database.report.findUniqueOrThrow({
      where: { id: response.json().data.id },
    });
    expect(report.reportedPhotoKey).toBe(photoKey);
    expect(report.evidenceStorageKey).toMatch(
      /^moderation-evidence\/profile-photos\/[0-9a-f-]{36}\.webp$/,
    );
    expect(
      await storage.getObject('private', report.evidenceStorageKey!),
    ).toEqual(await storage.getObject('public', photoKey!));
  });

  it('allows a separate report about the person, and refuses invalid targets', async () => {
    const person = await api('POST', '/reports', 'reporter', {
      targetType: 'USER',
      targetId: userIds.owner,
      reason: 'HARASSMENT',
    });
    const self = await api('POST', '/reports', 'owner', {
      targetType: 'PROFILE_PHOTO',
      targetId: userIds.owner,
      reason: 'HARASSMENT',
    });
    const noPhoto = await reportPhoto('plain');

    expect(person.statusCode).toBe(201);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF_REPORT');
    expect(noPhoto.statusCode).toBe(404);
  });
});

describe('removing a reported photo', () => {
  it('keeps the evidence when the user replaces the photo and does not remove the new one', async () => {
    const report = await database.report.findFirstOrThrow({
      where: { reporterId: userIds.reporter, targetType: 'PROFILE_PHOTO' },
    });
    const replacement = await uploadPhoto('owner', '#33aa33');
    expect(storage.keys('public')).not.toContain(report.reportedPhotoKey);
    expect(storage.keys('private')).toContain(report.evidenceStorageKey);

    const inspected = await api(
      'GET',
      `/admin/reports/${report.id}`,
      'moderator',
    );
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.target.photo).toMatchObject({
      stillCurrent: false,
      evidenceUrl: expect.stringContaining(report.evidenceStorageKey!),
    });

    const resolved = await claimAndResolve(report.id);
    expect(resolved.statusCode).toBe(409);
    expect(resolved.json().error.code).toBe('CONTENT_ALREADY_REMOVED');
    expect(await currentPhotoKey('owner')).toBe(replacement);
  });

  it('removes the reported photo, deletes the file, and tells the user', async () => {
    await database.report.updateMany({
      where: { reporterId: userIds.reporter, targetType: 'PROFILE_PHOTO' },
      data: { status: 'DISMISSED', resolvedAt: new Date() },
    });
    const photoKey = await currentPhotoKey('owner');
    const filed = await reportPhoto('owner');
    expect(filed.statusCode).toBe(201);

    const resolved = await claimAndResolve(filed.json().data.id);

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('ACTIONED');
    expect(await currentPhotoKey('owner')).toBeNull();
    expect(storage.keys('public')).not.toContain(photoKey);
    expect(await removalNotifications('owner')).toBe(1);
    expect(
      await database.moderationAction.count({
        where: {
          reportId: filed.json().data.id,
          action: 'CONTENT_REMOVED',
          targetType: 'PROFILE_PHOTO',
        },
      }),
    ).toBe(1);
  });
});

describe('direct removal by staff', () => {
  it('removes the photo, keeps evidence in the audit trail, and tells the user', async () => {
    const photoKey = await uploadPhoto('owner', '#3333aa');
    const response = await api(
      'POST',
      `/admin/users/${userIds.owner}/remove-profile-photo`,
      'moderator',
      { reason },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      userId: userIds.owner,
      profilePhotoRemoved: true,
    });
    expect(await currentPhotoKey('owner')).toBeNull();
    expect(storage.keys('public')).not.toContain(photoKey);
    const action = await database.moderationAction.findFirstOrThrow({
      where: {
        actorId: userIds.moderator,
        action: 'CONTENT_REMOVED',
        reportId: null,
      },
    });
    expect(action).toMatchObject({
      targetType: 'PROFILE_PHOTO',
      targetId: userIds.owner,
      reason,
    });
    expect(storage.keys('private')).toContain(action.evidenceStorageKey);
    expect(await removalNotifications('owner')).toBe(2);
  });

  it('refuses non-staff, protected staff accounts, and accounts without a photo', async () => {
    await uploadPhoto('admin', '#999999');
    const byUser = await api(
      'POST',
      `/admin/users/${userIds.admin}/remove-profile-photo`,
      'plain',
      { reason },
    );
    const onAdmin = await api(
      'POST',
      `/admin/users/${userIds.admin}/remove-profile-photo`,
      'moderator',
      { reason },
    );
    const noPhoto = await api(
      'POST',
      `/admin/users/${userIds.plain}/remove-profile-photo`,
      'moderator',
      { reason },
    );

    expect(byUser.statusCode).toBe(403);
    expect(byUser.json().error.code).toBe('STAFF_ONLY');
    expect(onAdmin.statusCode).toBe(403);
    expect(onAdmin.json().error.code).toBe('STAFF_TARGET_PROTECTED');
    expect(noPhoto.statusCode).toBe(409);
    expect(noPhoto.json().error.code).toBe('NO_PROFILE_PHOTO');
    expect(await currentPhotoKey('admin')).not.toBeNull();
  });
});

describe('evidence storage failures', () => {
  it('still files the report when the evidence copy fails', async () => {
    storage.failUploads = true;
    let response;
    try {
      response = await reportPhoto('admin');
    } finally {
      storage.failUploads = false;
    }

    expect(response.statusCode).toBe(201);
    const report = await database.report.findUniqueOrThrow({
      where: { id: response.json().data.id },
    });
    expect(report.reportedPhotoKey).toBe(await currentPhotoKey('admin'));
    expect(report.evidenceStorageKey).toBeNull();
  });
});
