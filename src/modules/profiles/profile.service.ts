import type { ProfileVisibility } from '@prisma/client';

import { AppError } from '../../errors/app-error.js';
import type { UpdateProfileInput } from './profile.types.js';

export interface UpdateProfileBody {
  displayName?: string;
  birthDate?: string;
  homeCity?: string | null;
  homeRegion?: string | null;
  biography?: string | null;
  languages?: string[];
  travelInterests?: string[];
  pastTripsVisibility?: ProfileVisibility;
  communityActivityVisibility?: ProfileVisibility;
}

function ageOnDate(birthDate: Date, today: Date): number {
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < birthDate.getUTCMonth() ||
    (today.getUTCMonth() === birthDate.getUTCMonth() &&
      today.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].filter(
    Boolean,
  );
}

export function normalizeProfileUpdate(
  body: UpdateProfileBody,
  today = new Date(),
): UpdateProfileInput {
  const result: UpdateProfileInput = {};

  if (body.displayName !== undefined) {
    const displayName = body.displayName.trim();
    if (displayName.length < 2) {
      throw new AppError(
        400,
        'INVALID_PROFILE',
        'Display name must contain at least two non-space characters.',
      );
    }
    result.displayName = displayName;
  }

  if (body.birthDate !== undefined) {
    const birthDate = new Date(`${body.birthDate}T00:00:00.000Z`);
    const age = ageOnDate(birthDate, today);
    if (age < 18 || age > 120) {
      throw new AppError(
        400,
        'AGE_RESTRICTION',
        'Travel Buddy accounts are available only to adults with a valid birth date.',
      );
    }
    result.birthDate = birthDate;
  }

  if (body.homeCity !== undefined) {
    result.homeCity = normalizeNullable(body.homeCity);
  }
  if (body.homeRegion !== undefined) {
    result.homeRegion = normalizeNullable(body.homeRegion);
  }
  if (body.biography !== undefined) {
    result.biography = normalizeNullable(body.biography);
  }
  if (body.languages !== undefined) {
    result.languages = normalizeList(body.languages);
  }
  if (body.travelInterests !== undefined) {
    result.travelInterests = normalizeList(body.travelInterests);
  }
  if (body.pastTripsVisibility !== undefined) {
    result.pastTripsVisibility = body.pastTripsVisibility;
  }
  if (body.communityActivityVisibility !== undefined) {
    result.communityActivityVisibility = body.communityActivityVisibility;
  }

  return result;
}

export function ageRange(birthDate: Date | null, today = new Date()) {
  if (!birthDate) return null;
  const age = ageOnDate(birthDate, today);
  if (age < 25) return '18-24' as const;
  if (age < 35) return '25-34' as const;
  if (age < 45) return '35-44' as const;
  if (age < 55) return '45-54' as const;
  return '55+' as const;
}
