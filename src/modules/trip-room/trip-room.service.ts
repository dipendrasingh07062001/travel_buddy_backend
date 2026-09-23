import { AppError } from '../../errors/app-error.js';
import type {
  ChecklistItemRecord,
  TripRoomRepository,
  UpdateChecklistItemBody,
} from './trip-room.types.js';

function cleanTitle(value: string): string {
  const title = value.trim();
  if (title.length < 2) {
    throw new AppError(
      400,
      'INVALID_CHECKLIST_ITEM_TITLE',
      'The checklist item title must contain at least 2 non-space characters.',
    );
  }
  return title;
}

function checklistResult(
  result: Awaited<ReturnType<TripRoomRepository['updateChecklistItem']>>,
): ChecklistItemRecord {
  switch (result.kind) {
    case 'updated':
      return result.item;
    case 'read_only':
      throw new AppError(
        409,
        'TRIP_ROOM_READ_ONLY',
        'Completed or cancelled trip rooms are read-only.',
      );
    case 'not_found':
      throw new AppError(
        404,
        'CHECKLIST_ITEM_NOT_FOUND',
        'Checklist item not found.',
      );
  }
}

export async function createChecklistItem(
  tripId: string,
  actorId: string,
  title: string,
  repository: TripRoomRepository,
  now = new Date(),
): Promise<ChecklistItemRecord> {
  const result = await repository.createChecklistItem({
    tripId,
    actorId,
    title: cleanTitle(title),
    now,
  });
  if (result.kind === 'not_found') {
    throw new AppError(
      404,
      'TRIP_ROOM_NOT_FOUND',
      'Private trip room not found.',
    );
  }
  return checklistResult(result);
}

export async function updateChecklistItem(
  itemId: string,
  actorId: string,
  body: UpdateChecklistItemBody,
  repository: TripRoomRepository,
  now = new Date(),
): Promise<ChecklistItemRecord> {
  if (body.title === undefined && body.completed === undefined) {
    throw new AppError(
      400,
      'EMPTY_CHECKLIST_ITEM_UPDATE',
      'Provide a title or completed state to update.',
    );
  }
  return checklistResult(
    await repository.updateChecklistItem({
      itemId,
      actorId,
      ...(body.title !== undefined && { title: cleanTitle(body.title) }),
      ...(body.completed !== undefined && { completed: body.completed }),
      now,
    }),
  );
}

export async function removeChecklistItem(
  itemId: string,
  actorId: string,
  repository: TripRoomRepository,
  now = new Date(),
): Promise<ChecklistItemRecord> {
  return checklistResult(
    await repository.removeChecklistItem(itemId, actorId, now),
  );
}

function membershipResult(
  result: Awaited<ReturnType<TripRoomRepository['leaveTrip']>>,
): void {
  switch (result.kind) {
    case 'updated':
      return;
    case 'not_found':
      throw new AppError(
        404,
        'ACTIVE_TRIP_MEMBERSHIP_NOT_FOUND',
        'Active trip membership not found.',
      );
    case 'owner_cannot_leave':
      throw new AppError(
        409,
        'TRIP_OWNER_CANNOT_LEAVE',
        'The trip owner cannot leave their own trip.',
      );
    case 'owner_cannot_be_removed':
      throw new AppError(
        409,
        'TRIP_OWNER_CANNOT_BE_REMOVED',
        'The trip owner cannot be removed from their own trip.',
      );
    case 'read_only':
      throw new AppError(
        409,
        'TRIP_ROOM_READ_ONLY',
        'Completed or cancelled trip rooms are read-only.',
      );
    case 'conflict':
      throw new AppError(
        409,
        'TRIP_MEMBERSHIP_CONFLICT',
        'Trip membership changed concurrently. Refresh and try again.',
      );
  }
}

export async function leaveTrip(
  tripId: string,
  userId: string,
  repository: TripRoomRepository,
  now = new Date(),
): Promise<void> {
  membershipResult(await repository.leaveTrip(tripId, userId, now));
}

export async function removeTripMember(
  tripId: string,
  actorId: string,
  memberId: string,
  repository: TripRoomRepository,
  now = new Date(),
): Promise<void> {
  membershipResult(
    await repository.removeMember(tripId, actorId, memberId, now),
  );
}
