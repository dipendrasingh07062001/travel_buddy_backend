import { PrismaClient } from '@prisma/client';

export const database = new PrismaClient();

export async function checkDatabase(): Promise<void> {
  await database.$queryRaw`SELECT 1`;
}
