import { AppError } from '../../errors/app-error.js';
import { requireSafePublicText } from '../../privacy/public-text.js';
import type {
  Prisma,
  TripDateMode,
  TripStatus,
  TripTransport,
} from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { requireCompleteProfile } from '../profiles/profile-completeness.js';
import type {
  CreateTripInput,
  TripManagementRepository,
} from './trip-management.types.js';
import type { PublicTripRecord } from './trip.types.js';

export interface CreateTripBody {
  communityId: string;
  originCity: string;
  startDate: string;
  endDate: string;
  flexibilityDays?: number;
  dateMode?: TripDateMode;
  weekendsOnly?: boolean;
  durationDays?: number;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string;
  currentGroupSize?: number;
  desiredGroupSize: number;
  transport?: TripTransport;
  description: string;
}

export interface UpdateTripBody {
  expectedVersion: number;
  communityId?: string;
  originCity?: string;
  startDate?: string;
  endDate?: string;
  flexibilityDays?: number;
  dateMode?: TripDateMode;
  weekendsOnly?: boolean;
  durationDays?: number;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currentGroupSize?: number;
  desiredGroupSize?: number;
  transport?: TripTransport;
  description?: string;
}

const datePlanFields = [
  'startDate',
  'endDate',
  'flexibilityDays',
  'dateMode',
  'weekendsOnly',
  'durationDays',
] as const;
const maximumWindowDays = 92;
const maximumWeekendTripDays = 4;

interface DatePlan {
  dateMode: TripDateMode;
  weekendsOnly: boolean;
  flexibilityDays: number;
  durationDays: number;
}

export interface VersionBody {
  expectedVersion: number;
  // Publish only: the owner ticked the publish confirmation.
  confirmsPersonalPlan?: boolean;
}

// What the owner confirms on every publish (PRD 7.2). Change the version
// whenever the wording changes, so each trip records which wording applied.
export const publishConfirmation = {
  version: '2026-10-27',
  statement:
    'This trip is my personal plan, accurate to the best of my knowledge, and not a commercial tour listing.',
} as const;

const editableStatuses: TripStatus[] = ['DRAFT', 'PUBLISHED', 'PAUSED'];

function invalid(code: string, message: string): never {
  throw new AppError(400, code, message);
}

function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalid('INVALID_TRIP_DATES', `${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return invalid('INVALID_TRIP_DATES', `${field} is not a valid date.`);
  }
  return parsed;
}

function durationDays(startDate: Date, endDate: Date): number {
  const days =
    Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (days < 1) {
    return invalid(
      'INVALID_TRIP_DATES',
      'endDate must be on or after startDate.',
    );
  }
  if (days > 365) {
    return invalid('INVALID_TRIP_DATES', 'A trip cannot exceed 365 days.');
  }
  return days;
}

// Same rule as the trips_date_mode_check constraint: counting Monday as 1 and
// Sunday as 7, the range must reach day 6 to include a Saturday or Sunday.
function includesWeekend(startDate: Date, days: number): boolean {
  return (startDate.getUTCDay() || 7) + days - 1 >= 6;
}

// An exact trip's length is its date range. A window holds a trip of the
// entered length somewhere inside the range, so it replaces day flexibility.
function resolveDatePlan(
  startDate: Date,
  endDate: Date,
  plan: Partial<DatePlan> & Pick<DatePlan, 'dateMode'>,
): DatePlan {
  const days = durationDays(startDate, endDate);
  if (plan.dateMode === 'EXACT') {
    if (plan.durationDays !== undefined) {
      invalid(
        'INVALID_TRIP_DATES',
        'durationDays is calculated from the dates of an exact trip.',
      );
    }
    if (plan.weekendsOnly) {
      invalid(
        'INVALID_TRIP_DATES',
        'weekendsOnly applies only to a date window.',
      );
    }
    return {
      dateMode: 'EXACT',
      weekendsOnly: false,
      flexibilityDays: plan.flexibilityDays ?? 0,
      durationDays: days,
    };
  }
  if (days > maximumWindowDays) {
    invalid(
      'INVALID_TRIP_DATES',
      `A date window cannot exceed ${maximumWindowDays} days.`,
    );
  }
  if (plan.flexibilityDays) {
    invalid(
      'INVALID_TRIP_DATES',
      'A date window already allows flexibility, so flexibilityDays must be 0.',
    );
  }
  if (plan.durationDays === undefined) {
    return invalid(
      'INVALID_TRIP_DATES',
      'durationDays is required for a date window.',
    );
  }
  if (plan.durationDays > days) {
    invalid(
      'INVALID_TRIP_DATES',
      'durationDays must fit inside the date window.',
    );
  }
  if (plan.weekendsOnly) {
    if (plan.durationDays > maximumWeekendTripDays) {
      invalid(
        'INVALID_TRIP_DATES',
        `A weekend trip can last at most ${maximumWeekendTripDays} days.`,
      );
    }
    if (!includesWeekend(startDate, days)) {
      invalid(
        'INVALID_TRIP_DATES',
        'A weekend window must include a Saturday or Sunday.',
      );
    }
  }
  return {
    dateMode: 'WINDOW',
    weekendsOnly: plan.weekendsOnly ?? false,
    flexibilityDays: 0,
    durationDays: plan.durationDays,
  };
}

function validateBudget(minimum: number | null, maximum: number | null): void {
  if (minimum !== null && maximum !== null && minimum > maximum) {
    invalid(
      'INVALID_TRIP_BUDGET',
      'budgetMin must be less than or equal to budgetMax.',
    );
  }
}

function validateGroup(current: number, desired: number): void {
  if (current > desired) {
    invalid(
      'INVALID_GROUP_SIZE',
      'currentGroupSize cannot exceed desiredGroupSize.',
    );
  }
}

async function validateCommunity(
  repository: TripManagementRepository,
  communityId: string,
): Promise<void> {
  if (!(await repository.isActiveCommunity(communityId))) {
    invalid('INVALID_COMMUNITY', 'The selected community is not active.');
  }
}

function requireOwner(
  trip: PublicTripRecord | null,
  ownerId: string,
): PublicTripRecord {
  if (!trip) throw new AppError(404, 'TRIP_NOT_FOUND', 'Trip not found.');
  if (trip.ownerId !== ownerId) {
    throw new AppError(
      403,
      'TRIP_FORBIDDEN',
      'Only the trip owner can perform this action.',
    );
  }
  if (trip.moderationRemovedAt) {
    throw new AppError(
      403,
      'TRIP_REMOVED_BY_MODERATION',
      'This trip was removed by moderation.',
    );
  }
  return trip;
}

function requireVersion(trip: PublicTripRecord, expectedVersion: number): void {
  if (trip.version !== expectedVersion) {
    throw new AppError(
      409,
      'TRIP_VERSION_CONFLICT',
      'The trip changed since it was loaded. Refresh it and try again.',
    );
  }
}

function requireStatus(trip: PublicTripRecord, statuses: TripStatus[]): void {
  if (!statuses.includes(trip.status)) {
    throw new AppError(
      409,
      'INVALID_TRIP_STATE',
      `This action is not allowed while the trip is ${trip.status}.`,
    );
  }
}

export async function createTrip(
  ownerId: string,
  body: CreateTripBody,
  repository: TripManagementRepository,
): Promise<PublicTripRecord> {
  requireSafePublicText(body.originCity);
  requireSafePublicText(body.description);
  await validateCommunity(repository, body.communityId);
  const startDate = parseDate(body.startDate, 'startDate');
  const endDate = parseDate(body.endDate, 'endDate');
  const budgetMin = body.budgetMin ?? null;
  const budgetMax = body.budgetMax ?? null;
  const currentGroupSize = body.currentGroupSize ?? 1;
  validateBudget(budgetMin, budgetMax);
  validateGroup(currentGroupSize, body.desiredGroupSize);

  const input: CreateTripInput = {
    ownerId,
    communityId: body.communityId,
    originCity: body.originCity.trim(),
    startDate,
    endDate,
    ...resolveDatePlan(startDate, endDate, {
      dateMode: body.dateMode ?? 'EXACT',
      ...(body.weekendsOnly !== undefined && {
        weekendsOnly: body.weekendsOnly,
      }),
      ...(body.flexibilityDays !== undefined && {
        flexibilityDays: body.flexibilityDays,
      }),
      ...(body.durationDays !== undefined && {
        durationDays: body.durationDays,
      }),
    }),
    budgetMin,
    budgetMax,
    currency: body.currency ?? 'INR',
    currentGroupSize,
    desiredGroupSize: body.desiredGroupSize,
    transport: body.transport ?? 'UNDECIDED',
    description: body.description.trim(),
  };
  return repository.create(input);
}

export async function updateTrip(
  ownerId: string,
  tripId: string,
  body: UpdateTripBody,
  repository: TripManagementRepository,
): Promise<PublicTripRecord> {
  const trip = requireOwner(await repository.findById(tripId), ownerId);
  requireVersion(trip, body.expectedVersion);
  requireStatus(trip, editableStatuses);
  requireSafePublicText(body.originCity);
  requireSafePublicText(body.description);
  if (body.communityId !== undefined) {
    await validateCommunity(repository, body.communityId);
  }

  const startDate = body.startDate
    ? parseDate(body.startDate, 'startDate')
    : trip.startDate;
  const endDate = body.endDate
    ? parseDate(body.endDate, 'endDate')
    : trip.endDate;
  const budgetMin =
    body.budgetMin !== undefined
      ? body.budgetMin
      : (trip.budgetMin?.toNumber() ?? null);
  const budgetMax =
    body.budgetMax !== undefined
      ? body.budgetMax
      : (trip.budgetMax?.toNumber() ?? null);
  const currentGroupSize = body.currentGroupSize ?? trip.currentGroupSize;
  const desiredGroupSize = body.desiredGroupSize ?? trip.desiredGroupSize;
  validateBudget(budgetMin, budgetMax);
  validateGroup(currentGroupSize, desiredGroupSize);

  // Changing the date type drops settings that only belong to the old type.
  const dateMode = body.dateMode ?? trip.dateMode;
  const keepsMode = dateMode === trip.dateMode;
  const weekendsOnly =
    body.weekendsOnly ?? (keepsMode ? trip.weekendsOnly : undefined);
  const flexibilityDays =
    body.flexibilityDays ?? (keepsMode ? trip.flexibilityDays : undefined);
  const windowDays =
    body.durationDays ??
    (keepsMode && dateMode === 'WINDOW' ? trip.durationDays : undefined);
  const datePlan = datePlanFields.some((field) => body[field] !== undefined)
    ? resolveDatePlan(startDate, endDate, {
        dateMode,
        ...(weekendsOnly !== undefined && { weekendsOnly }),
        ...(flexibilityDays !== undefined && { flexibilityDays }),
        ...(windowDays !== undefined && { durationDays: windowDays }),
      })
    : null;

  const data: Prisma.TripUncheckedUpdateManyInput = {
    ...(body.communityId !== undefined && { communityId: body.communityId }),
    ...(body.originCity !== undefined && {
      originCity: body.originCity.trim(),
    }),
    ...(body.description !== undefined && {
      description: body.description.trim(),
    }),
    ...(body.startDate !== undefined && { startDate }),
    ...(body.endDate !== undefined && { endDate }),
    ...datePlan,
    ...(body.budgetMin !== undefined && { budgetMin: body.budgetMin }),
    ...(body.budgetMax !== undefined && { budgetMax: body.budgetMax }),
    ...(body.currentGroupSize !== undefined && {
      currentGroupSize: body.currentGroupSize,
    }),
    ...(body.desiredGroupSize !== undefined && {
      desiredGroupSize: body.desiredGroupSize,
    }),
    ...(body.transport !== undefined && { transport: body.transport }),
  };
  const updated = await repository.updateOwned(
    tripId,
    ownerId,
    body.expectedVersion,
    editableStatuses,
    data,
  );
  if (!updated) {
    throw new AppError(
      409,
      'TRIP_VERSION_CONFLICT',
      'The trip changed while it was being updated.',
    );
  }
  return updated;
}

const transitions = {
  publish: {
    from: ['DRAFT', 'PAUSED'] as TripStatus[],
    to: 'PUBLISHED' as TripStatus,
  },
  pause: { from: ['PUBLISHED'] as TripStatus[], to: 'PAUSED' as TripStatus },
  'mark-full': {
    from: ['PUBLISHED'] as TripStatus[],
    to: 'FULL' as TripStatus,
  },
  cancel: {
    from: ['DRAFT', 'PUBLISHED', 'PAUSED', 'FULL'] as TripStatus[],
    to: 'CANCELLED' as TripStatus,
  },
  complete: {
    from: ['PUBLISHED', 'FULL'] as TripStatus[],
    to: 'COMPLETED' as TripStatus,
  },
} as const;

export type TripAction = keyof typeof transitions;

export async function transitionTrip(
  owner: AuthenticatedUser,
  tripId: string,
  action: TripAction,
  { expectedVersion, confirmsPersonalPlan }: VersionBody,
  repository: TripManagementRepository,
  now = new Date(),
): Promise<PublicTripRecord> {
  const trip = requireOwner(await repository.findById(tripId), owner.id);
  requireVersion(trip, expectedVersion);
  const transition = transitions[action];
  requireStatus(trip, transition.from);
  if (action === 'publish') {
    // Asked again on every publish: a paused plan may have been edited.
    if (confirmsPersonalPlan !== true) {
      throw new AppError(
        400,
        'PUBLISH_CONFIRMATION_REQUIRED',
        'Confirm that this plan is personal, accurate to the best of your knowledge and not a commercial tour listing.',
      );
    }
    requireCompleteProfile(owner, 'publishing a trip');
    // Recheck stored drafts and paused records created before these guards.
    requireSafePublicText(trip.originCity);
    requireSafePublicText(trip.description);
  }

  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (action === 'publish' && trip.startDate < today) {
    throw new AppError(
      409,
      'INVALID_TRIP_STATE',
      'A trip starting in the past cannot be published.',
    );
  }
  if (action === 'complete' && trip.endDate > today) {
    throw new AppError(
      409,
      'INVALID_TRIP_STATE',
      'A trip cannot be completed before its end date.',
    );
  }

  const updated = await repository.updateOwned(
    tripId,
    owner.id,
    expectedVersion,
    transition.from,
    {
      status: transition.to,
      ...(action === 'publish' && !trip.publishedAt && { publishedAt: now }),
      ...(action === 'publish' && {
        publishConfirmedAt: now,
        publishConfirmationVersion: publishConfirmation.version,
      }),
    },
  );
  if (!updated) {
    throw new AppError(
      409,
      'TRIP_VERSION_CONFLICT',
      'The trip changed while its status was being updated.',
    );
  }
  return updated;
}
