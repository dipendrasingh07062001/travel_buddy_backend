import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
const [userId] = process.argv.slice(2);
const operator = process.env.STAFF_GRANT_OPERATOR?.trim();

if (
  !userId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    userId,
  ) ||
  !operator ||
  operator.length > 100
) {
  throw new Error(
    'Usage: set STAFF_GRANT_OPERATOR to your operator name, then run npm run staff:revoke -- <user-uuid>. This requires direct database credentials.',
  );
}

try {
  await database.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { staffRole: true },
    });
    if (!user || user.staffRole === 'USER') {
      throw new Error('Target must be an existing staff account.');
    }
    if (user.staffRole === 'ADMIN') {
      const admins = await tx.user.count({
        where: { staffRole: 'ADMIN', status: 'ACTIVE' },
      });
      if (admins <= 1)
        throw new Error('Cannot revoke the last active administrator.');
    }
    const changed = await tx.user.updateMany({
      where: { id: userId, staffRole: user.staffRole },
      data: { staffRole: 'USER' },
    });
    if (changed.count !== 1)
      throw new Error('Staff role changed during revocation.');
    await tx.moderationAction.create({
      data: {
        action: 'STAFF_ROLE_REVOKED',
        targetType: 'USER',
        targetId: userId,
        reason: `Operator ${operator} revoked ${user.staffRole} through the database-only CLI.`,
      },
    });
  });
  process.stdout.write(`Revoked staff role from ${userId}.\n`);
} finally {
  await database.$disconnect();
}
