import type { Prisma } from '@prisma/client';

// A shared row lock keeps a concurrent admin merge/archive from moving or
// disabling the community between validation and the new content write.
export async function lockActiveCommunity(
  transaction: Prisma.TransactionClient,
  communityId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM communities
    WHERE id = ${communityId}::uuid AND status = 'ACTIVE'
    FOR SHARE
  `;
  return rows.length === 1;
}
