import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  AuthenticatedUser,
  AuthRepository,
  TokenVerifier,
} from '../src/modules/auth/auth.types.js';
import type {
  ConnectionRepository,
  ConnectionRequestRecord,
  MembershipRecord,
} from '../src/modules/connections/connection.types.js';

const ownerId = '80000000-0000-4000-8000-000000000001';
const requesterId = '80000000-0000-4000-8000-000000000002';
const outsiderId = '80000000-0000-4000-8000-000000000003';
const incompleteId = '80000000-0000-4000-8000-000000000004';
const targetTripIds = [
  '90000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000003',
];

function completeUser(id: string, displayName: string): AuthenticatedUser {
  return {
    id,
    displayName,
    birthDate: new Date('1995-05-20T00:00:00.000Z'),
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    profile: {
      profilePhotoStorageKey: null,
      homeCity: 'Delhi',
      homeRegion: 'Delhi NCR',
      biography: 'Traveller interested in small group mountain trips.',
      languages: ['english', 'hindi'],
      travelInterests: ['trekking'],
      pastTripsVisibility: 'MEMBERS_ONLY',
      communityActivityVisibility: 'PUBLIC',
    },
  };
}

const users: Record<string, AuthenticatedUser> = {
  'owner-token': completeUser(ownerId, 'Trip Owner'),
  'requester-token': completeUser(requesterId, 'Trip Requester'),
  'outsider-token': completeUser(outsiderId, 'Outsider'),
  'incomplete-token': {
    ...completeUser(incompleteId, 'Incomplete User'),
    birthDate: null,
    profile: null,
  },
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

const requests = new Map<string, ConnectionRequestRecord>();
const memberships = new Map<string, MembershipRecord[]>();
for (const tripId of targetTripIds) {
  memberships.set(tripId, [
    {
      id: randomUUID(),
      tripId,
      userId: ownerId,
      connectionRequestId: null,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date('2026-09-01T00:00:00.000Z'),
      leftAt: null,
      removedAt: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      user: users['owner-token']!,
    },
  ]);
}

function connectionRecord(
  tripId: string,
  input: {
    requesterId: string;
    recipientId: string;
    message: string;
    relatedTripId: string | null;
  },
): ConnectionRequestRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    tripId,
    requesterId: input.requesterId,
    recipientId: input.recipientId,
    relatedTripId: input.relatedTripId,
    message: input.message,
    status: 'PENDING',
    decidedById: null,
    decidedAt: null,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
    requester: Object.values(users).find(
      (user) => user.id === input.requesterId,
    )!,
    recipient: { id: ownerId, displayName: 'Trip Owner' },
    trip: {
      id: tripId,
      ownerId,
      status: 'PUBLISHED',
      startDate: new Date('2027-01-10T00:00:00.000Z'),
      endDate: new Date('2027-01-15T00:00:00.000Z'),
      currentGroupSize: 1,
      desiredGroupSize: 2,
      community: { slug: 'manali', name: 'Manali' },
    },
    relatedTrip: null,
  };
}

const repository: ConnectionRepository = {
  async findRequestableTrip(tripId) {
    if (!targetTripIds.includes(tripId)) return null;
    return {
      id: tripId,
      ownerId,
      status: 'PUBLISHED',
      currentGroupSize: memberships.get(tripId)!.length,
      desiredGroupSize: 2,
    };
  },
  async isOwnedPublicTrip() {
    return true;
  },
  async findExisting(tripId, requestedBy) {
    return (
      [...requests.values()].find(
        (request) =>
          request.tripId === tripId && request.requesterId === requestedBy,
      ) ?? null
    );
  },
  async countRecentByRequester() {
    return 0;
  },
  async create(input) {
    const request = connectionRecord(input.tripId, input);
    requests.set(request.id, request);
    return request;
  },
  async list(userId, query) {
    const matching = [...requests.values()].filter(
      (request) =>
        (query.box === 'received'
          ? request.recipientId === userId
          : request.requesterId === userId) &&
        (!query.status || request.status === query.status),
    );
    return { requests: matching, totalItems: matching.length };
  },
  async findById(id) {
    return requests.get(id) ?? null;
  },
  async setPendingStatus(id, actorId, actorField, status, now) {
    const request = requests.get(id);
    if (
      !request ||
      request.status !== 'PENDING' ||
      request[actorField] !== actorId
    ) {
      return null;
    }
    const updated: ConnectionRequestRecord = {
      ...request,
      status,
      updatedAt: now,
      ...(status === 'DECLINED'
        ? { decidedById: actorId, decidedAt: now }
        : { withdrawnAt: now }),
    };
    requests.set(id, updated);
    return updated;
  },
  async accept(id, recipientId, now) {
    const request = requests.get(id);
    if (!request || request.recipientId !== recipientId) {
      return { kind: 'not_found' };
    }
    if (request.status !== 'PENDING') {
      return { kind: 'not_pending', request };
    }
    const updated: ConnectionRequestRecord = {
      ...request,
      status: 'ACCEPTED',
      decidedById: recipientId,
      decidedAt: now,
      updatedAt: now,
    };
    requests.set(id, updated);
    memberships.get(request.tripId)!.push({
      id: randomUUID(),
      tripId: request.tripId,
      userId: request.requesterId,
      connectionRequestId: request.id,
      role: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: now,
      leftAt: null,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
      user: request.requester,
    });
    return { kind: 'accepted', request: updated };
  },
  async listActiveMembers(tripId, viewerId) {
    const members = memberships.get(tripId) ?? [];
    if (!members.some((member) => member.userId === viewerId)) return null;
    return members;
  },
};

const app = buildApp({
  logger: false,
  health: { checkReadiness: async () => undefined },
  auth: { tokenVerifier, repository: authRepository },
  connections: { repository },
});

const headers = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe('connection request HTTP contract', () => {
  let acceptedRequestId: string;

  it('requires a sufficiently complete profile', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${targetTripIds[0]}/connection-requests`,
      headers: headers('incomplete-token'),
      payload: { message: 'I would like to discuss joining this travel plan.' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROFILE_INCOMPLETE');
  });

  it('rejects a message containing only whitespace', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${targetTripIds[0]}/connection-requests`,
      headers: headers('requester-token'),
      payload: { message: '                         ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CONNECTION_MESSAGE');
  });

  it('creates a trip-specific pending request and prevents duplicates', async () => {
    const payload = {
      message:
        'I am available for these dates and would like to discuss the plan.',
    };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${targetTripIds[0]}/connection-requests`,
      headers: headers('requester-token'),
      payload,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/trips/${targetTripIds[0]}/connection-requests`,
      headers: headers('requester-token'),
      payload,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      status: 'PENDING',
      requester: { id: requesterId },
      recipient: { id: ownerId },
      trip: { id: targetTripIds[0] },
    });
    acceptedRequestId = created.json().data.id;
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONNECTION_REQUEST_EXISTS');
  });

  it('keeps sent and received inboxes scoped to the authenticated user', async () => {
    const received = await app.inject({
      method: 'GET',
      url: '/api/v1/me/connection-requests?box=received&status=PENDING',
      headers: headers('owner-token'),
    });
    const sent = await app.inject({
      method: 'GET',
      url: '/api/v1/me/connection-requests?box=sent',
      headers: headers('requester-token'),
    });
    const outsider = await app.inject({
      method: 'GET',
      url: '/api/v1/me/connection-requests?box=received',
      headers: headers('outsider-token'),
    });

    expect(received.json().data).toHaveLength(1);
    expect(sent.json().data).toHaveLength(1);
    expect(outsider.json().data).toHaveLength(0);
  });

  it('allows only the trip owner to accept and grants private membership', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${acceptedRequestId}/accept`,
      headers: headers('outsider-token'),
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/connection-requests/${acceptedRequestId}/accept`,
      headers: headers('owner-token'),
    });
    const memberList = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${targetTripIds[0]}/members`,
      headers: headers('requester-token'),
    });
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/trips/${targetTripIds[0]}/members`,
      headers: headers('outsider-token'),
    });

    expect(forbidden.statusCode).toBe(404);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe('ACCEPTED');
    expect(memberList.statusCode).toBe(200);
    expect(
      memberList
        .json()
        .data.map((member: { user: { id: string } }) => member.user.id),
    ).toEqual([ownerId, requesterId]);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.code).toBe('TRIP_MEMBERSHIP_REQUIRED');
  });

  it.each([
    ['withdraw', 'requester-token', 'WITHDRAWN'],
    ['decline', 'owner-token', 'DECLINED'],
  ])(
    'supports the %s terminal action',
    async (action, token, expectedStatus) => {
      const tripId =
        action === 'withdraw' ? targetTripIds[1] : targetTripIds[2];
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/trips/${tripId}/connection-requests`,
        headers: headers('requester-token'),
        payload: {
          message: 'Please consider this separate trip connection request.',
        },
      });
      const acted = await app.inject({
        method: 'POST',
        url: `/api/v1/connection-requests/${created.json().data.id}/${action}`,
        headers: headers(token),
      });

      expect(acted.statusCode).toBe(200);
      expect(acted.json().data.status).toBe(expectedStatus);
    },
  );
});
