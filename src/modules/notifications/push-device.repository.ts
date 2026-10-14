import { database } from '../../database/client.js';
import { AppError } from '../../errors/app-error.js';
import type { Prisma, PushPlatform } from '../../generated/prisma/client.js';

// Older registrations beyond this are usually reinstalled apps or cleared
// browsers whose tokens no longer work.
const maximumDevicesPerUser = 10;

const pushDeviceSelect = {
  id: true,
  platform: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PushDeviceSelect;

export type PushDeviceRecord = Prisma.PushDeviceGetPayload<{
  select: typeof pushDeviceSelect;
}>;

// A token identifies one app install or browser. Registering it again
// refreshes it; registering it from another account moves it there, because
// the device is now signed in to that account.
export async function registerPushDevice(
  userId: string,
  token: string,
  platform: PushPlatform,
): Promise<PushDeviceRecord> {
  return database.$transaction(async (transaction) => {
    const device = await transaction.pushDevice.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
      select: pushDeviceSelect,
    });
    const surplus = await transaction.pushDevice.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: maximumDevicesPerUser,
      select: { id: true },
    });
    if (surplus.length > 0) {
      await transaction.pushDevice.deleteMany({
        where: { id: { in: surplus.map((item) => item.id) } },
      });
    }
    return device;
  });
}

export function listPushDevices(userId: string): Promise<PushDeviceRecord[]> {
  return database.pushDevice.findMany({
    where: { userId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: pushDeviceSelect,
  });
}

export async function removePushDevice(
  userId: string,
  deviceId: string,
): Promise<void> {
  const result = await database.pushDevice.deleteMany({
    where: { id: deviceId, userId },
  });
  if (result.count === 0) {
    throw new AppError(
      404,
      'PUSH_DEVICE_NOT_FOUND',
      'Push device registration not found.',
    );
  }
}
