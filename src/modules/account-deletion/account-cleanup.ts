import { createHash, randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { database } from '../../database/client.js';
import type {
  AccountCleanupKind,
  Prisma,
} from '../../generated/prisma/client.js';
import type { ObjectStorage } from '../../storage/object-storage.js';

export interface SignInAccountRemover {
  remove(subject: string): Promise<void>;
}

export interface AccountCleanupOptions {
  storage: ObjectStorage | null;
  signInAccounts?: SignInAccountRemover;
  logger: FastifyBaseLogger;
  now?: Date;
}

export interface AccountCleanupResult {
  claimed: number;
  completed: number;
  retrying: number;
}

interface CleanupTarget {
  kind: AccountCleanupKind;
  target: string;
}

interface ClaimedTask extends CleanupTarget {
  id: string;
  userId: string;
  attempts: number;
}

const batchSize = 50;
const abandonedClaimMs = 5 * 60 * 1000;
const initialRetryMs = 10 * 60 * 1000;
const maximumRetryMs = 24 * 60 * 60 * 1000;
// ID tokens last one hour and are verified without asking Firebase whether
// the account still exists, so a token issued before provider deletion stays
// valid for up to an hour afterwards. The guard blocks bootstrap for that
// hour, plus a margin for clock differences, so it cannot recreate the local
// account.
const signInGuardMs = 65 * 60 * 1000;

export function firebaseSignInGuardTarget(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

// The outbox is written in the transaction that removes the original links.
// A rollback preserves those links; a commit preserves the cleanup targets.
export async function queueAccountCleanup(
  transaction: Prisma.TransactionClient,
  userId: string,
  targets: CleanupTarget[],
  now: Date,
): Promise<void> {
  if (targets.length === 0) return;
  await transaction.accountCleanupTask.createMany({
    data: targets.map((task) => ({
      ...task,
      userId,
      createdAt: now,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
}

async function removeTarget(
  task: CleanupTarget,
  options: AccountCleanupOptions,
): Promise<void> {
  if (task.kind === 'FIREBASE_SIGN_IN_GUARD') {
    // The task becomes due when its guard expires; no provider call is needed.
    return;
  } else if (task.kind === 'FIREBASE_ACCOUNT') {
    if (!options.signInAccounts) {
      throw new Error('Sign-in account cleanup is not configured.');
    }
    await options.signInAccounts.remove(task.target);
  } else {
    if (!options.storage) {
      throw new Error('File cleanup is not configured.');
    }
    await options.storage.deleteObject(
      task.kind === 'PUBLIC_OBJECT' ? 'public' : 'private',
      task.target,
    );
  }
}

// Provider deletes are idempotent: a missing Firebase account or R2 object
// counts as success. Failed jobs remain until they succeed, even if the API
// restarts or the provider is not configured yet.
export async function processAccountCleanupBatch(
  options: AccountCleanupOptions,
): Promise<AccountCleanupResult> {
  const now = options.now ?? new Date();
  const claimToken = randomUUID();
  const abandonedBefore = new Date(now.getTime() - abandonedClaimMs);
  const tasks = await database.$queryRaw<ClaimedTask[]>`
    UPDATE "account_cleanup_tasks"
    SET "claim_token" = ${claimToken}::uuid,
        "claimed_at" = ${now},
        "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "account_cleanup_tasks"
      WHERE "next_attempt_at" <= ${now}
        AND ("claimed_at" IS NULL OR "claimed_at" <= ${abandonedBefore})
      ORDER BY "next_attempt_at", "created_at", "id"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "user_id" AS "userId", "kind", "target", "attempts"
  `;
  const result = { claimed: tasks.length, completed: 0, retrying: 0 };

  for (const task of tasks) {
    try {
      await removeTarget(task, options);
      // A recovered job has a new claim token. A late worker must not clear
      // or reschedule a job that another API instance now owns.
      const removed = await database.$transaction(async (tx) => {
        const deleted = await tx.accountCleanupTask.deleteMany({
          where: { id: task.id, claimToken },
        });
        if (deleted.count === 1 && task.kind === 'FIREBASE_ACCOUNT') {
          const target = firebaseSignInGuardTarget(task.target);
          const nextAttemptAt = new Date(now.getTime() + signInGuardMs);
          await tx.accountCleanupTask.upsert({
            where: { kind_target: { kind: 'FIREBASE_SIGN_IN_GUARD', target } },
            create: {
              userId: task.userId,
              kind: 'FIREBASE_SIGN_IN_GUARD',
              target,
              createdAt: now,
              nextAttemptAt,
            },
            update: { nextAttemptAt, claimToken: null, claimedAt: null },
          });
        }
        return deleted;
      });
      result.completed += removed.count;
    } catch {
      const delay = Math.min(
        initialRetryMs * 2 ** Math.min(task.attempts - 1, 8),
        maximumRetryMs,
      );
      const nextAttemptAt = new Date(now.getTime() + delay);
      const scheduled = await database.accountCleanupTask.updateMany({
        where: { id: task.id, claimToken },
        data: { claimToken: null, claimedAt: null, nextAttemptAt },
      });
      result.retrying += scheduled.count;
      if (scheduled.count > 0) {
        // UIDs, object keys, and provider error text can contain personal
        // data. Logs identify the task without copying its cleanup target.
        options.logger.warn(
          {
            taskId: task.id,
            kind: task.kind,
            attempts: task.attempts,
            nextAttemptAt,
          },
          'Account cleanup failed; retry scheduled',
        );
      }
    }
  }
  return result;
}
