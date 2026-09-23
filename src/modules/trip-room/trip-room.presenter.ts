import type {
  ChecklistItemRecord,
  ChecklistItemView,
} from './trip-room.types.js';

export function presentChecklistItem(
  item: ChecklistItemRecord,
): ChecklistItemView {
  return {
    id: item.id,
    tripId: item.tripId,
    title: item.title,
    status: item.status,
    createdBy: item.createdBy,
    completedBy: item.completedBy,
    completedAt: item.completedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
