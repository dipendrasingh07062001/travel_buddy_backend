import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { database } from '../src/database/client.js';
import { processAccountCleanupBatch } from '../src/modules/account-deletion/account-cleanup.js';
import { processAccountErasures } from '../src/modules/account-deletion/account-erasure.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const userIds = new Set<string>();
const subject = `cleanup-${randomUUID()}`;
const app = buildApp({
  logger: false,
  auth: {
    tokenVerifier: {
      async verify() {
        return { subject, emailVerified: false, authTime: new Date() };
      },
    },
  },
});
const day = 86_400_000;
const minute = 60_000;

beforeAll(() => app.ready());

afterEach(async () => {
  const ids = [...userIds];
  await database.accountCleanupTask.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.accountDataRequest.deleteMany({
    where: { userId: { in: ids } },
  });
  await database.report.deleteMany({
    where: {
      OR: [{ reporterId: { in: ids } }, { reportedUserId: { in: ids } }],
    },
  });
  await database.user.deleteMany({ where: { id: { in: ids } } });
  userIds.clear();
});

afterAll(async () => {
  await app.close();
  await database.$disconnect();
});

async function deletedUser() {
  const user = await database.user.create({
    data: { status: 'DELETED', deletedAt: new Date() },
  });
  userIds.add(user.id);
  return user;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('durable account cleanup', () => {
  it('keeps retry targets after local erasure and blocks a login awaiting Firebase deletion', async () => {
    const now = new Date();
    const photoKey = `profile-photos/${randomUUID()}.webp`;
    const storage = new MemoryStorage();
    await storage.putObject({
      bucket: 'public',
      key: photoKey,
      body: Buffer.from('photo'),
      contentType: 'image/webp',
      cacheControl: 'public',
    });
    const user = await database.user.create({
      data: {
        status: 'PENDING_DELETION',
        statusBeforeDeletion: 'ACTIVE',
        profile: { create: { profilePhotoStorageKey: photoKey } },
        authAccounts: {
          create: { provider: 'FIREBASE', providerSubject: subject },
        },
        dataRequests: {
          create: {
            type: 'ACCOUNT_DELETION',
            scheduledFor: new Date(now.getTime() - minute),
          },
        },
      },
    });
    userIds.add(user.id);
    const failed = await processAccountErasures({
      storage: null,
      logger: app.log,
      now,
    });
    expect(failed.erased).toBe(1);
    expect(failed.cleanup).toEqual({ claimed: 2, completed: 0, retrying: 2 });
    expect(
      await database.userProfile.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(
      await database.authAccount.count({ where: { userId: user.id } }),
    ).toBe(0);
    const tasks = await database.accountCleanupTask.findMany({
      where: { userId: user.id },
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.target)).toEqual(
      expect.arrayContaining([photoKey, subject]),
    );
    expect(
      tasks.every((task) => task.claimToken === null && task.attempts === 1),
    ).toBe(true);
    expect(
      tasks.every((task) => task.nextAttemptAt.getTime() > now.getTime()),
    ).toBe(true);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { authorization: 'Bearer cleanup-user' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ACCOUNT_CLEANUP_PENDING');
    expect(
      await database.authAccount.count({ where: { providerSubject: subject } }),
    ).toBe(0);

    const removed: string[] = [];
    const options = {
      storage,
      logger: app.log,
      signInAccounts: {
        async remove(id: string) {
          removed.push(id);
        },
      },
    };
    const early = await processAccountCleanupBatch({
      ...options,
      now: new Date(now.getTime() + minute),
    });
    expect(early.claimed).toBe(0);
    const retried = await processAccountCleanupBatch({
      ...options,
      now: new Date(now.getTime() + 11 * minute),
    });
    expect(retried).toEqual({ claimed: 2, completed: 2, retrying: 0 });
    expect(removed).toEqual([subject]);
    expect(storage.keys('public')).not.toContain(photoKey);
    const remaining = await database.accountCleanupTask.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: 'FIREBASE_SIGN_IN_GUARD' });
    expect(remaining[0]?.target).not.toBe(subject);
    expect(remaining[0]?.target).toMatch(/^[a-f0-9]{64}$/);
    const staleRequest = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { authorization: 'Bearer already-verified-token' },
    });
    expect(staleRequest.statusCode).toBe(403);
    expect(staleRequest.json().error.code).toBe('ACCOUNT_CLEANUP_PENDING');
    // Expired guards do not need credentials and are removed automatically.
    const expired = await processAccountCleanupBatch({
      storage: null,
      logger: app.log,
      now: new Date(now.getTime() + 72 * minute),
    });
    expect(expired.completed).toBe(1);
    expect(
      await database.accountCleanupTask.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it('retries a provider outage even when file storage is available', async () => {
    const user = await deletedUser();
    const now = new Date();
    const task = await database.accountCleanupTask.create({
      data: {
        userId: user.id,
        kind: 'FIREBASE_ACCOUNT',
        target: `retry-${randomUUID()}`,
        nextAttemptAt: now,
      },
    });
    const failed = await processAccountCleanupBatch({
      storage: new MemoryStorage(),
      logger: app.log,
      now,
      signInAccounts: {
        async remove() {
          throw new Error('Provider unavailable');
        },
      },
    });
    expect(failed.retrying).toBe(1);
    expect(
      await database.accountCleanupTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({ attempts: 1, claimToken: null });
    const success = await processAccountCleanupBatch({
      storage: null,
      logger: app.log,
      now: new Date(now.getTime() + 11 * minute),
      signInAccounts: { async remove() {} },
    });
    expect(success.completed).toBe(1);
  });

  it('queues evidence deletion before clearing moderation references', async () => {
    const user = await deletedUser();
    const reporter = await deletedUser();
    const now = new Date();
    const key = `moderation-evidence/${randomUUID()}.webp`;
    await database.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(now.getTime() - 366 * day) },
    });
    const report = await database.report.create({
      data: {
        reporterId: reporter.id,
        reportedUserId: user.id,
        targetType: 'PROFILE_PHOTO',
        reportedPhotoKey: `profile-photos/${randomUUID()}.webp`,
        reason: 'HARASSMENT',
        evidenceStorageKey: key,
      },
    });
    const result = await processAccountErasures({
      storage: null,
      logger: app.log,
      now,
    });
    expect(result.purged).toBe(1);
    expect(result.cleanup.retrying).toBe(1);
    expect(
      await database.report.findUniqueOrThrow({
        where: { id: report.id },
        select: { evidenceStorageKey: true },
      }),
    ).toEqual({ evidenceStorageKey: null });
    expect(
      await database.accountCleanupTask.findFirstOrThrow({
        where: { userId: user.id },
      }),
    ).toMatchObject({ kind: 'PRIVATE_OBJECT', target: key });

    const storage = new MemoryStorage();
    await storage.putObject({
      bucket: 'private',
      key,
      body: Buffer.from('evidence'),
      contentType: 'image/webp',
      cacheControl: 'private',
    });
    const retried = await processAccountCleanupBatch({
      storage,
      logger: app.log,
      now: new Date(now.getTime() + 11 * minute),
    });
    expect(retried.completed).toBe(1);
    expect(storage.keys('private')).not.toContain(key);
  });

  it('retains a storage target when the delete request fails', async () => {
    const user = await deletedUser();
    const now = new Date();
    const key = `profile-photos/${randomUUID()}.webp`;
    let available = false;
    class UnavailableStorage extends MemoryStorage {
      override async deleteObject(
        bucket: 'public' | 'private',
        target: string,
      ) {
        if (!available) throw new Error('Storage unavailable');
        return super.deleteObject(bucket, target);
      }
    }
    const storage = new UnavailableStorage();
    await storage.putObject({
      bucket: 'public',
      key,
      body: Buffer.from('photo'),
      contentType: 'image/webp',
      cacheControl: 'public',
    });
    await database.accountCleanupTask.create({
      data: {
        userId: user.id,
        kind: 'PUBLIC_OBJECT',
        target: key,
        nextAttemptAt: now,
      },
    });
    const failed = await processAccountCleanupBatch({
      storage,
      logger: app.log,
      now,
    });
    expect(failed.retrying).toBe(1);
    expect(storage.keys('public')).toContain(key);
    available = true;
    const retried = await processAccountCleanupBatch({
      storage,
      logger: app.log,
      now: new Date(now.getTime() + 11 * minute),
    });
    expect(retried.completed).toBe(1);
    expect(storage.keys('public')).not.toContain(key);
  });

  it('lets concurrent workers claim each task only once', async () => {
    const user = await deletedUser();
    const now = new Date();
    await database.accountCleanupTask.createMany({
      data: Array.from({ length: 8 }, () => ({
        userId: user.id,
        kind: 'FIREBASE_ACCOUNT' as const,
        target: randomUUID(),
        nextAttemptAt: now,
      })),
    });
    const removed: string[] = [];
    const options = {
      storage: null,
      logger: app.log,
      now,
      signInAccounts: {
        async remove(target: string) {
          removed.push(target);
        },
      },
    };
    const results = await Promise.all([
      processAccountCleanupBatch(options),
      processAccountCleanupBatch(options),
    ]);
    expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(8);
    expect(removed).toHaveLength(8);
    expect(new Set(removed).size).toBe(8);
  });

  it('recovers abandoned tasks and leaves recent claims alone', async () => {
    const user = await deletedUser();
    const now = new Date();
    const abandoned = await database.accountCleanupTask.create({
      data: {
        userId: user.id,
        kind: 'PUBLIC_OBJECT',
        target: randomUUID(),
        nextAttemptAt: now,
        claimToken: randomUUID(),
        claimedAt: new Date(now.getTime() - 6 * minute),
        attempts: 1,
      },
    });
    const recent = await database.accountCleanupTask.create({
      data: {
        userId: user.id,
        kind: 'PUBLIC_OBJECT',
        target: randomUUID(),
        nextAttemptAt: now,
        claimToken: randomUUID(),
        claimedAt: now,
        attempts: 1,
      },
    });
    const result = await processAccountCleanupBatch({
      storage: new MemoryStorage(),
      logger: app.log,
      now,
    });
    expect(result.completed).toBe(1);
    expect(
      await database.accountCleanupTask.findUnique({
        where: { id: abandoned.id },
      }),
    ).toBeNull();
    expect(
      await database.accountCleanupTask.findUniqueOrThrow({
        where: { id: recent.id },
      }),
    ).toMatchObject({ claimToken: recent.claimToken, attempts: 1 });
  });

  it('prevents a late worker from clearing a replacement claim', async () => {
    const user = await deletedUser();
    const now = new Date();
    const task = await database.accountCleanupTask.create({
      data: {
        userId: user.id,
        kind: 'FIREBASE_ACCOUNT',
        target: randomUUID(),
        nextAttemptAt: now,
      },
    });
    const started = deferred();
    const finish = deferred();
    const running = processAccountCleanupBatch({
      storage: null,
      logger: app.log,
      now,
      signInAccounts: {
        async remove() {
          started.resolve();
          await finish.promise;
        },
      },
    });
    await started.promise;
    const replacementClaim = randomUUID();
    try {
      await database.accountCleanupTask.update({
        where: { id: task.id },
        data: {
          claimToken: replacementClaim,
          claimedAt: new Date(now.getTime() + 6 * minute),
          attempts: 2,
        },
      });
    } finally {
      finish.resolve();
    }
    expect((await running).completed).toBe(0);
    expect(
      await database.accountCleanupTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({ claimToken: replacementClaim, attempts: 2 });
  });
});
