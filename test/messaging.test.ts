import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  MessageRecord,
  MessagingRepository,
  RoomRecord,
} from '../src/modules/messaging/messaging.types.js';

const ownerId = 'c0000000-0000-4000-8000-000000000001';
const memberId = 'c0000000-0000-4000-8000-000000000002';
const outsiderId = 'c0000000-0000-4000-8000-000000000003';
const tripId = 'd0000000-0000-4000-8000-000000000001';
const conversationId = 'e0000000-0000-4000-8000-000000000001';

function testUser(id: string, displayName: string): AuthenticatedUser {
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
      biography: 'Travel profile used for messaging contract tests.',
      languages: ['english'],
      travelInterests: ['trekking'],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

const users: Record<string, AuthenticatedUser> = {
  'owner-token': testUser(ownerId, 'Room Owner'),
  'member-token': testUser(memberId, 'Room Member'),
  'outsider-token': testUser(outsiderId, 'Room Outsider'),
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

const room: RoomRecord = {
  id: conversationId,
  tripId,
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  updatedAt: new Date('2026-09-20T00:00:00.000Z'),
  trip: {
    id: tripId,
    status: 'PUBLISHED',
    originCity: 'Delhi',
    startDate: new Date('2026-10-10T00:00:00.000Z'),
    endDate: new Date('2026-10-15T00:00:00.000Z'),
    flexibilityDays: 2,
    durationDays: 6,
    transport: 'BUS',
    description: 'A shared Manali trip plan for room contract tests.',
    version: 1,
    community: {
      id: '20000000-0000-4000-8000-000000000001',
      slug: 'manali',
      name: 'Manali',
      region: 'Himachal Pradesh',
      countryCode: 'IN',
    },
    memberships: [
      {
        role: 'OWNER',
        joinedAt: new Date('2026-09-20T00:00:00.000Z'),
        user: users['owner-token']!,
      },
      {
        role: 'MEMBER',
        joinedAt: new Date('2026-09-20T00:05:00.000Z'),
        user: users['member-token']!,
      },
    ],
    checklistItems: [],
  },
  participants: [
    {
      userId: ownerId,
      lastReadAt: null,
      mutedAt: null,
      joinedAt: new Date('2026-09-20T00:00:00.000Z'),
    },
    {
      userId: memberId,
      lastReadAt: null,
      mutedAt: null,
      joinedAt: new Date('2026-09-20T00:05:00.000Z'),
    },
  ],
};

const messages: MessageRecord[] = [];
let blocked = false;
let readOnly = false;
let noRecipients = false;

function hasAccess(userId: string): boolean {
  return [ownerId, memberId].includes(userId);
}

function record(senderId: string, body: string, now: Date): MessageRecord {
  return {
    id: randomUUID(),
    conversationId,
    senderId,
    body,
    status: 'ACTIVE',
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    sender: Object.values(users).find((user) => user.id === senderId)!,
  };
}

const repository: MessagingRepository = {
  async findRoom(requestedTripId, userId) {
    return requestedTripId === tripId && hasAccess(userId) ? room : null;
  },
  async listMessages(requestedTripId, userId, query) {
    if (requestedTripId !== tripId || !hasAccess(userId)) {
      return { kind: 'room_not_found' };
    }
    let start = 0;
    if (query.cursor) {
      const cursorIndex = messages.findIndex(
        (message) => message.id === query.cursor,
      );
      if (cursorIndex < 0) return { kind: 'invalid_cursor' };
      start = cursorIndex + 1;
    }
    const page = messages.slice(start, start + query.pageSize);
    return {
      kind: 'ok',
      messages: page,
      nextCursor:
        start + query.pageSize < messages.length ? page.at(-1)!.id : null,
    };
  },
  async createMessage(requestedTripId, senderId, body, now) {
    if (requestedTripId !== tripId || !hasAccess(senderId)) {
      return { kind: 'room_not_found' };
    }
    if (readOnly) return { kind: 'read_only' };
    if (noRecipients) return { kind: 'no_recipients' };
    if (blocked) return { kind: 'blocked' };
    const message = record(senderId, body, now);
    messages.unshift(message);
    return { kind: 'created', message };
  },
  async changeMessage(messageId, senderId, action, body, now) {
    const index = messages.findIndex(
      (message) => message.id === messageId && message.senderId === senderId,
    );
    if (index < 0 || !hasAccess(senderId)) return { kind: 'not_found' };
    if (readOnly) return { kind: 'read_only' };
    const current = messages[index]!;
    if (current.status === 'DELETED') {
      return { kind: 'invalid_state', status: current.status };
    }
    const updated: MessageRecord =
      action === 'EDIT'
        ? {
            ...current,
            body: body!,
            status: 'EDITED',
            editedAt: now,
            updatedAt: now,
          }
        : {
            ...current,
            status: 'DELETED',
            deletedAt: now,
            updatedAt: now,
          };
    messages[index] = updated;
    return { kind: 'updated', message: updated };
  },
  async markRead(requestedTripId, userId, now) {
    if (requestedTripId !== tripId || !hasAccess(userId)) return false;
    const state = room.participants.find((value) => value.userId === userId)!;
    state.lastReadAt = now;
    return true;
  },
  async setMuted(requestedTripId, userId, muted, now) {
    if (requestedTripId !== tripId || !hasAccess(userId)) return null;
    const state = room.participants.find((value) => value.userId === userId)!;
    state.mutedAt = muted ? now : null;
    return room;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  messaging: { repository },
});
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('private trip-room messaging HTTP contract', () => {
  let ownedMessageId = '';

  it('allows only active trip members to open the room', async () => {
    const member = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('member-token'),
    });
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/room`,
      headers: headers('outsider-token'),
    });
    expect(member.statusCode).toBe(200);
    expect(member.json().data.members).toHaveLength(2);
    expect(member.json().data.plan.destination.slug).toBe('manali');
    expect(member.json().data.checklist).toEqual([]);
    expect(member.json().data.safetyNotice).toContain('financial credentials');
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json().error.code).toBe('TRIP_ROOM_NOT_FOUND');
  });

  it('rejects whitespace and sends a trimmed private message', async () => {
    const whitespace = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: '    ' },
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: '  Let us meet at the bus terminal at 8 AM.  ' },
    });
    expect(whitespace.statusCode).toBe(400);
    expect(whitespace.json().error.code).toBe('INVALID_MESSAGE_BODY');
    expect(sent.statusCode).toBe(201);
    expect(sent.json().data.body).toBe(
      'Let us meet at the bus terminal at 8 AM.',
    );
    ownedMessageId = sent.json().data.id;
  });

  it('does not allow chat before another member has been accepted', async () => {
    noRecipients = true;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: 'There is nobody else in this room yet.' },
    });
    noRecipients = false;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('TRIP_ROOM_NO_RECIPIENTS');
  });

  it('hides messages from outsiders and supports cursor pagination', async () => {
    for (const body of ['Second message', 'Third message']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/trips/${tripId}/messages`,
        headers: headers('member-token'),
        payload: { body },
      });
    }
    const firstPage = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages?pageSize=2`,
      headers: headers('member-token'),
    });
    const cursor = firstPage.json().pagination.nextCursor as string;
    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages?pageSize=2&cursor=${cursor}`,
      headers: headers('member-token'),
    });
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('outsider-token'),
    });
    expect(firstPage.json().data).toHaveLength(2);
    expect(cursor).toBeTruthy();
    expect(secondPage.json().data).toHaveLength(1);
    expect(outsider.statusCode).toBe(404);
  });

  it('allows only the sender to edit and soft-delete a message', async () => {
    const otherEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${ownedMessageId}`,
      headers: headers('member-token'),
      payload: { body: 'I must not edit another user message.' },
    });
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${ownedMessageId}`,
      headers: headers('owner-token'),
      payload: { body: 'Meet at the bus terminal at 8:30 AM.' },
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/messages/${ownedMessageId}`,
      headers: headers('owner-token'),
    });
    const editDeleted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${ownedMessageId}`,
      headers: headers('owner-token'),
      payload: { body: 'Deleted messages cannot be restored this way.' },
    });
    expect(otherEdit.statusCode).toBe(404);
    expect(edited.json().data.status).toBe('EDITED');
    expect(deleted.json().data).toMatchObject({
      body: null,
      status: 'DELETED',
    });
    expect(editDeleted.statusCode).toBe(409);
    expect(editDeleted.json().error.code).toBe('MESSAGE_ALREADY_DELETED');
  });

  it('records read and mute preferences for the authenticated member', async () => {
    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/read`,
      headers: headers('member-token'),
    });
    const muted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/trips/${tripId}/room/preferences`,
      headers: headers('member-token'),
      payload: { muted: true },
    });
    expect(read.statusCode).toBe(204);
    expect(muted.json().data.preferences.muted).toBe(true);
    expect(muted.json().data.preferences.lastReadAt).toBeTruthy();
  });

  it('prevents messaging when every other active member is blocked', async () => {
    blocked = true;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('owner-token'),
      payload: { body: 'This message must not be delivered.' },
    });
    blocked = false;
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CONTACT_BLOCKED');
  });

  it('makes completed or cancelled rooms read-only', async () => {
    readOnly = true;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${tripId}/messages`,
      headers: headers('member-token'),
      payload: { body: 'This message must not be created.' },
    });
    readOnly = false;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('TRIP_ROOM_READ_ONLY');
  });
});
