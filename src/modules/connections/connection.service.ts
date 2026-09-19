import { Prisma } from '@prisma/client';

import { AppError } from '../../errors/app-error.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import type {
  ConnectionRepository,
  ConnectionRequestRecord,
} from './connection.types.js';

export interface CreateConnectionRequestBody {
  message: string;
  relatedTripId?: string;
}

const maximumRequestsPerDay = 20;

function requireRequestProfile(user: AuthenticatedUser): void {
  if (
    !user.displayName ||
    !user.birthDate ||
    !user.profile?.homeCity ||
    !user.profile.biography ||
    user.profile.languages.length === 0
  ) {
    throw new AppError(
      409,
      'PROFILE_INCOMPLETE',
      'Complete your display name, birth date, home city, biography, and languages before requesting a connection.',
    );
  }
}

export async function sendConnectionRequest(
  user: AuthenticatedUser,
  tripId: string,
  body: CreateConnectionRequestBody,
  repository: ConnectionRepository,
  now = new Date(),
): Promise<ConnectionRequestRecord> {
  requireRequestProfile(user);
  const message = body.message.trim();
  if (message.length < 20) {
    throw new AppError(
      400,
      'INVALID_CONNECTION_MESSAGE',
      'The connection message must contain at least 20 non-space characters.',
    );
  }
  const trip = await repository.findRequestableTrip(tripId);
  if (!trip) {
    throw new AppError(
      404,
      'TRIP_NOT_REQUESTABLE',
      'This trip is not available for connection requests.',
    );
  }
  if (trip.ownerId === user.id) {
    throw new AppError(
      409,
      'SELF_CONNECTION_REQUEST',
      'You cannot request a connection to your own trip.',
    );
  }
  if (trip.currentGroupSize >= trip.desiredGroupSize) {
    throw new AppError(
      409,
      'TRIP_FULL',
      'This trip has no available group spaces.',
    );
  }

  if (await repository.isBlockedEitherDirection(user.id, trip.ownerId)) {
    throw new AppError(
      403,
      'CONTACT_BLOCKED',
      'This connection action is unavailable.',
    );
  }

  const existing = await repository.findExisting(tripId, user.id);
  if (existing) {
    throw new AppError(
      409,
      'CONNECTION_REQUEST_EXISTS',
      `A ${existing.status.toLowerCase()} connection request already exists for this trip.`,
    );
  }

  if (
    body.relatedTripId &&
    !(await repository.isOwnedPublicTrip(body.relatedTripId, user.id))
  ) {
    throw new AppError(
      400,
      'INVALID_RELATED_TRIP',
      'The related trip must be one of your published or full trips.',
    );
  }

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (
    (await repository.countRecentByRequester(user.id, since)) >=
    maximumRequestsPerDay
  ) {
    throw new AppError(
      429,
      'CONNECTION_REQUEST_LIMIT',
      'You have reached the connection-request limit for the last 24 hours.',
    );
  }

  try {
    return await repository.create({
      tripId,
      requesterId: user.id,
      recipientId: trip.ownerId,
      relatedTripId: body.relatedTripId ?? null,
      message,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AppError(
        409,
        'CONNECTION_REQUEST_EXISTS',
        'A connection request already exists for this trip.',
      );
    }
    throw error;
  }
}

function requireVisibleRequest(
  request: ConnectionRequestRecord | null,
  userId: string,
  role: 'recipient' | 'requester',
): ConnectionRequestRecord {
  if (
    !request ||
    (role === 'recipient'
      ? request.recipientId !== userId
      : request.requesterId !== userId)
  ) {
    throw new AppError(
      404,
      'CONNECTION_REQUEST_NOT_FOUND',
      'Connection request not found.',
    );
  }
  return request;
}

export async function acceptConnectionRequest(
  userId: string,
  requestId: string,
  repository: ConnectionRepository,
  now = new Date(),
): Promise<ConnectionRequestRecord> {
  const request = requireVisibleRequest(
    await repository.findById(requestId),
    userId,
    'recipient',
  );
  if (request.status === 'ACCEPTED') return request;
  if (request.status === 'BLOCKED') {
    throw new AppError(
      403,
      'CONTACT_BLOCKED',
      'This connection action is unavailable.',
    );
  }
  if (request.status !== 'PENDING') {
    throw new AppError(
      409,
      'INVALID_CONNECTION_REQUEST_STATE',
      `A ${request.status.toLowerCase()} request cannot be accepted.`,
    );
  }

  const result = await repository.accept(requestId, userId, now);
  switch (result.kind) {
    case 'accepted':
      return result.request;
    case 'trip_full':
      throw new AppError(
        409,
        'TRIP_FULL',
        'This trip has no available group spaces.',
      );
    case 'trip_unavailable':
      throw new AppError(
        409,
        'TRIP_NOT_REQUESTABLE',
        'This trip is no longer accepting members.',
      );
    case 'blocked':
      throw new AppError(
        403,
        'CONTACT_BLOCKED',
        'This connection action is unavailable.',
      );
    case 'not_pending':
      if (result.request.status === 'ACCEPTED') return result.request;
      if (result.request.status === 'BLOCKED') {
        throw new AppError(
          403,
          'CONTACT_BLOCKED',
          'This connection action is unavailable.',
        );
      }
      throw new AppError(
        409,
        'INVALID_CONNECTION_REQUEST_STATE',
        'The request was already resolved.',
      );
    case 'conflict':
      throw new AppError(
        409,
        'CONNECTION_REQUEST_CONFLICT',
        'The request changed while it was being accepted. Refresh and try again.',
      );
    case 'not_found':
      throw new AppError(
        404,
        'CONNECTION_REQUEST_NOT_FOUND',
        'Connection request not found.',
      );
  }
}

export async function declineConnectionRequest(
  userId: string,
  requestId: string,
  repository: ConnectionRepository,
  now = new Date(),
): Promise<ConnectionRequestRecord> {
  const request = requireVisibleRequest(
    await repository.findById(requestId),
    userId,
    'recipient',
  );
  if (request.status === 'DECLINED') return request;
  if (request.status !== 'PENDING') {
    throw new AppError(
      409,
      'INVALID_CONNECTION_REQUEST_STATE',
      'Only a pending request can be declined.',
    );
  }
  const updated = await repository.setPendingStatus(
    requestId,
    userId,
    'recipientId',
    'DECLINED',
    now,
  );
  if (!updated) {
    throw new AppError(
      409,
      'CONNECTION_REQUEST_CONFLICT',
      'The request changed while it was being declined.',
    );
  }
  return updated;
}

export async function withdrawConnectionRequest(
  userId: string,
  requestId: string,
  repository: ConnectionRepository,
  now = new Date(),
): Promise<ConnectionRequestRecord> {
  const request = requireVisibleRequest(
    await repository.findById(requestId),
    userId,
    'requester',
  );
  if (request.status === 'WITHDRAWN') return request;
  if (request.status !== 'PENDING') {
    throw new AppError(
      409,
      'INVALID_CONNECTION_REQUEST_STATE',
      'Only a pending request can be withdrawn.',
    );
  }
  const updated = await repository.setPendingStatus(
    requestId,
    userId,
    'requesterId',
    'WITHDRAWN',
    now,
  );
  if (!updated) {
    throw new AppError(
      409,
      'CONNECTION_REQUEST_CONFLICT',
      'The request changed while it was being withdrawn.',
    );
  }
  return updated;
}
