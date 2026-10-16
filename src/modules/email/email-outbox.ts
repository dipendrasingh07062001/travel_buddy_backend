import type {
  NotificationType,
  Prisma,
} from '../../generated/prisma/client.js';
import { emailDeliveryConfigured } from './email.configuration.js';
import { emailCategory } from './email-policy.js';
import { emailCategoryFields } from './email.types.js';

interface NewNotification {
  id: string;
  recipientId: string;
  type: NotificationType;
}

export async function queueEmailNotifications(
  tx: Prisma.TransactionClient,
  notifications: NewNotification[],
): Promise<void> {
  // While unconfigured, do not enqueue anything. Later enabling a provider
  // must not turn the historic inbox into an unexpected email backlog.
  if (!emailDeliveryConfigured() || notifications.length === 0) return;
  const preferences = await tx.emailPreference.findMany({
    where: {
      userId: { in: [...new Set(notifications.map((row) => row.recipientId))] },
      user: { status: 'ACTIVE', deletedAt: null },
    },
  });
  const byUser = new Map(preferences.map((row) => [row.userId, row]));
  const data = notifications.flatMap((row) => {
    const category = emailCategory(row.type);
    const preference = byUser.get(row.recipientId);
    if (!category || !preference?.[emailCategoryFields[category]]) return [];
    return [
      {
        notificationId: row.id,
        category,
        preferenceVersion: preference.version,
      },
    ];
  });
  if (data.length)
    await tx.emailDelivery.createMany({ data, skipDuplicates: true });
}
