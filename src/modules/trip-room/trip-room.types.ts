import type { Prisma, TripChecklistItemStatus } from '@prisma/client';

export const checklistItemInclude = {
  createdBy: { select: { id: true, displayName: true } },
  completedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.TripChecklistItemInclude;

export type ChecklistItemRecord = Prisma.TripChecklistItemGetPayload<{
  include: typeof checklistItemInclude;
}>;

export interface CreateChecklistItemInput {
  tripId: string;
  actorId: string;
  title: string;
  now: Date;
}

export interface UpdateChecklistItemInput {
  itemId: string;
  actorId: string;
  title?: string;
  completed?: boolean;
  now: Date;
}

export type ChecklistMutationResult =
  | { kind: 'updated'; item: ChecklistItemRecord }
  | { kind: 'not_found' }
  | { kind: 'read_only' };

export type MembershipMutationResult =
  | { kind: 'updated' }
  | { kind: 'not_found' }
  | { kind: 'owner_cannot_leave' }
  | { kind: 'owner_cannot_be_removed' }
  | { kind: 'read_only' }
  | { kind: 'conflict' };

export interface TripRoomRepository {
  createChecklistItem(
    input: CreateChecklistItemInput,
  ): Promise<ChecklistMutationResult>;
  updateChecklistItem(
    input: UpdateChecklistItemInput,
  ): Promise<ChecklistMutationResult>;
  removeChecklistItem(
    itemId: string,
    actorId: string,
    now: Date,
  ): Promise<ChecklistMutationResult>;
  leaveTrip(
    tripId: string,
    userId: string,
    now: Date,
  ): Promise<MembershipMutationResult>;
  removeMember(
    tripId: string,
    actorId: string,
    memberId: string,
    now: Date,
  ): Promise<MembershipMutationResult>;
}

export interface TripRoomRouteDependencies {
  repository: TripRoomRepository;
}

export interface UpdateChecklistItemBody {
  title?: string;
  completed?: boolean;
}

export interface ChecklistItemView {
  id: string;
  tripId: string;
  title: string;
  status: TripChecklistItemStatus;
  createdBy: { id: string; displayName: string | null };
  completedBy: { id: string; displayName: string | null } | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
