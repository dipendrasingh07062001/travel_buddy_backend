import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
const [userId, role] = process.argv.slice(2);
const operator = process.env.STAFF_GRANT_OPERATOR?.trim();

if (
  !userId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    userId,
  ) ||
  !['MODERATOR', 'ADMIN'].includes(role ?? '') ||
  !operator ||
  operator.length > 100
) {
  throw new Error(
    'Usage: set STAFF_GRANT_OPERATOR to your operator name, then run npm run staff:grant -- <user-uuid> <MODERATOR|ADMIN>. This requires direct database credentials.',
  );
}

try {
  await database.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({
      where: { id: userId, status: 'ACTIVE', staffRole: 'USER' },
      data: { staffRole: role },
    });
    if (changed.count !== 1) {
      throw new Error(
        'Target must be an existing active account with USER role.',
      );
    }
    await tx.moderationAction.create({
      data: {
        action: 'STAFF_ROLE_GRANTED',
        targetType: 'USER',
        targetId: userId,
        reason: `Operator ${operator} granted ${role} through the database-only CLI.`,
      },
    });
  });
  process.stdout.write(`Granted ${role} to ${userId}.\n`);
} finally {
  await database.$disconnect();
}
