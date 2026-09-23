import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  ChecklistItemRecord,
  TripRoomRepository,
} from '../src/modules/trip-room/trip-room.types.js';

const ownerId = 'f0000000-0000-4000-8000-000000000001';
const memberId = 'f0000000-0000-4000-8000-000000000002';
const otherMemberId = 'f0000000-0000-4000-8000-000000000003';
const outsiderId = 'f0000000-0000-4000-8000-000000000004';
const tripId = 'f1000000-0000-4000-8000-000000000001';

function user(id: string, displayName: string): AuthenticatedUser {
  return {
    id,
    displayName,
    birthDate: new Date('1994-01-10T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: {
      profilePhotoStorageKey: null,
      homeCity: 'Delhi',
      homeRegion: 'Delhi NCR',
      biography: 'Trip-room coordination test profile.',
      languages: ['english'],
      travelInterests: ['road trips'],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

const users: Record<string, AuthenticatedUser> = {
  'owner-token': user(ownerId, 'Trip Owner'),
  'member-token': user(memberId, 'Trip Member'),
  'other-token': user(otherMemberId, 'Other Member'),
  'outsider-token': user(outsiderId, 'Outsider'),
};

const tokenVerifier: TokenVerifier = {
  async verify(token) {
    return { subject: token, emailVerified: false };
  },
};

const authRepository: AuthRepository = {
  async bootstrapFirebaseUser(identity) {
    return { user: users[identity.subject]!, created: false };
  },
  async findFirebaseUser(subject) {
    return users[subject] ?? null;
  },
};

let activeMembers = new Set<string>();
let items = new Map<string, ChecklistItemRecord>();
let readOnly = false;

function record(
  createdById: string,
  title: string,
  now: Date,
): ChecklistItemRecord {
  return {
    id: randomUUID(),
    tripId,
    createdById,
    completedById: null,
    title,
    status: 'OPEN',
    completedAt: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: {
      id: createdById,
      displayName:
        Object.values(users).find((value) => value.id === createdById)
          ?.displayName ?? null,
    },
    completedBy: null,
  };
}

const repository: TripRoomRepository = {
  async createChecklistItem(input) {
    if (input.tripId !== tripId || !activeMembers.has(input.actorId)) {
      return { kind: 'not_found' };
    }
    if (readOnly) return { kind: 'read_only' };
    const item = record(input.actorId, input.title, input.now);
    items.set(item.id, item);
    return { kind: 'updated', item };
  },
  async updateChecklistItem(input) {
    const current = items.get(input.itemId);
    if (!current || !activeMembers.has(input.actorId)) {
      return { kind: 'not_found' };
    }
    if (readOnly) return { kind: 'read_only' };
    const completedBy = input.completed
      ? {
          id: input.actorId,
          displayName:
            Object.values(users).find((value) => value.id === input.actorId)
              ?.displayName ?? null,
        }
      : input.completed === false
        ? null
        : current.completedBy;
    const item: ChecklistItemRecord = {
      ...current,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.completed !== undefined && {
        status: input.completed ? 'COMPLETED' : 'OPEN',
        completedById: input.completed ? input.actorId : null,
        completedBy,
        completedAt: input.completed ? input.now : null,
      }),
      updatedAt: input.now,
    };
    items.set(item.id, item);
    return { kind: 'updated', item };
  },
  async removeChecklistItem(itemId, actorId, now) {
    const current = items.get(itemId);
    if (
      !current ||
      !activeMembers.has(actorId) ||
      (current.createdById !== actorId && actorId !== ownerId)
    ) {
      return { kind: 'not_found' };
    }
    if (readOnly) return { kind: 'read_only' };
    const item: ChecklistItemRecord = {
      ...current,
      status: 'REMOVED',
      removedAt: now,
      updatedAt: now,
    };
    items.set(itemId, item);
    return { kind: 'updated', item };
  },
  async leaveTrip(requestedTripId, userId) {
    if (requestedTripId !== tripId || !activeMembers.has(userId)) {
      return { kind: 'not_found' };
    }
    if (userId === ownerId) return { kind: 'owner_cannot_leave' };
    if (readOnly) return { kind: 'read_only' };
    activeMembers.delete(userId);
    return { kind: 'updated' };
  },
  async removeMember(requestedTripId, actorId, targetId) {
    if (
      requestedTripId !== tripId ||
      actorId !== ownerId ||
      !activeMembers.has(actorId) ||
      !activeMembers.has(targetId)
    ) {
      return { kind: 'not_found' };
    }
    if (targetId === ownerId) return { kind: 'owner_cannot_be_removed' };
    if (readOnly) return { kind: 'read_only' };
    activeMembers.delete(targetId);
    return { kind: 'updated' };
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  tripRoom: { repository },
});
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => app.ready());
afterAll(async () => app.close());
beforeEach(() => {
  activeMembers = new Set([ownerId, memberId, otherMemberId]);
  items = new Map();
  readOnly = false;
});

describe('trip-room coordination HTTP contract', () => {
  it('lets an active member create and complete a trimmed checklist item', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-token'),
      payload: { title: '  Confirm bus tickets  ' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      title: 'Confirm bus tickets',
      status: 'OPEN',
    });

    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/checklist-items/${created.json().data.id}`,
      headers: headers('other-token'),
      payload: { completed: true },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().data).toMatchObject({
      status: 'COMPLETED',
      completedBy: { id: otherMemberId },
    });
  });

  it('hides checklist actions from outsiders and validates meaningful updates', async () => {
    const outsider = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('outsider-token'),
      payload: { title: 'Attempt private checklist access' },
    });
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error.code).toBe('TRIP_ROOM_NOT_FOUND');

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/checklist-items/${randomUUID()}`,
      headers: headers('member-token'),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('allows only the creator or trip owner to soft-remove an item', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-token'),
      payload: { title: 'Reserve the hotel' },
    });
    const itemId = created.json().data.id as string;
    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/checklist-items/${itemId}`,
      headers: headers('other-token'),
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/checklist-items/${itemId}`,
      headers: headers('owner-token'),
    });
    expect(denied.statusCode).toBe(404);
    expect(removed.json().data.status).toBe('REMOVED');
  });

  it('revokes access when a member leaves and prevents the owner leaving', async () => {
    const left = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/leave`,
      headers: headers('member-token'),
    });
    const afterLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-token'),
      payload: { title: 'Must no longer be allowed' },
    });
    const ownerLeave = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/leave`,
      headers: headers('owner-token'),
    });
    expect(left.statusCode).toBe(204);
    expect(afterLeave.statusCode).toBe(404);
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json().error.code).toBe('TRIP_OWNER_CANNOT_LEAVE');
  });

  it('allows only the owner to remove a non-owner member', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/members/${otherMemberId}/remove`,
      headers: headers('member-token'),
    });
    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/members/${otherMemberId}/remove`,
      headers: headers('owner-token'),
    });
    expect(denied.statusCode).toBe(404);
    expect(removed.statusCode).toBe(204);
    expect(activeMembers.has(otherMemberId)).toBe(false);
  });

  it('makes checklist and membership mutations read-only after trip end', async () => {
    readOnly = true;
    const checklist = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/checklist-items`,
      headers: headers('member-token'),
      payload: { title: 'Must not be created' },
    });
    const leave = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/leave`,
      headers: headers('member-token'),
    });
    expect(checklist.statusCode).toBe(409);
    expect(checklist.json().error.code).toBe('TRIP_ROOM_READ_ONLY');
    expect(leave.statusCode).toBe(409);
    expect(leave.json().error.code).toBe('TRIP_ROOM_READ_ONLY');
  });
});
