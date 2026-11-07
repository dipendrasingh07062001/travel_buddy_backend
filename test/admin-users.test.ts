import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/app-error.js';
import {
  escapeLike,
  isActiveRestriction,
  normalizeContact,
  parseSearchQuery,
  safeFailure,
} from '../src/modules/admin-users/admin-users.service.js';

function rejection(raw: string): AppError {
  try {
    parseSearchQuery(raw);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the search to be rejected.');
}

describe('parseSearchQuery', () => {
  it('leaves a missing query undefined', () => {
    expect(parseSearchQuery(undefined)).toBeUndefined();
  });

  it.each(['a', '  a  ', '   '])(
    'rejects %j as too short after trimming',
    (raw) => {
      const error = rejection(raw);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('INVALID_USER_SEARCH');
    },
  );

  it.each(['priya@example.com', '+919876543210', '  +91 98'])(
    'sends %j to the contact lookup without repeating it',
    (raw) => {
      const error = rejection(raw);
      expect(error.code).toBe('USE_CONTACT_LOOKUP');
      expect(error.message).not.toContain(raw.trim());
    },
  );

  it('treats a UUID as an exact ID in lower case', () => {
    expect(parseSearchQuery(' 8F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9 ')).toEqual({
      kind: 'id',
      value: '8f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9',
    });
  });

  it('treats other text as a trimmed name search', () => {
    expect(parseSearchQuery('  Priya S ')).toEqual({
      kind: 'name',
      value: 'Priya S',
    });
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('%_\\x')).toBe('\\%\\_\\\\x');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('normalizeContact', () => {
  it('trims and lower-cases emails as sign-in stores them', () => {
    expect(normalizeContact('EMAIL', '  Priya@Example.COM ')).toBe(
      'priya@example.com',
    );
  });

  it('only trims phone numbers', () => {
    expect(normalizeContact('PHONE', ' +919876543210 ')).toBe('+919876543210');
  });
});

describe('isActiveRestriction', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');
  const hour = 3_600_000;
  const base = {
    startsAt: new Date(now.getTime() - hour),
    endsAt: null,
    liftedAt: null,
  };

  it('is active without an end date', () => {
    expect(isActiveRestriction(base, now)).toBe(true);
  });

  it('is active before its end date', () => {
    expect(
      isActiveRestriction(
        { ...base, endsAt: new Date(now.getTime() + hour) },
        now,
      ),
    ).toBe(true);
  });

  it('is inactive once lifted, expired, ending now or not yet started', () => {
    expect(isActiveRestriction({ ...base, liftedAt: now }, now)).toBe(false);
    expect(
      isActiveRestriction(
        { ...base, endsAt: new Date(now.getTime() - 1) },
        now,
      ),
    ).toBe(false);
    expect(isActiveRestriction({ ...base, endsAt: now }, now)).toBe(false);
    expect(
      isActiveRestriction(
        { ...base, startsAt: new Date(now.getTime() + hour) },
        now,
      ),
    ).toBe(false);
  });
});

describe('safeFailure', () => {
  class PrismaClientKnownRequestError extends Error {
    code = 'P2003';
  }

  it('keeps only the class name and Prisma code', () => {
    const error = new PrismaClientKnownRequestError(
      'Invalid query with normalizedValue: "priya@example.com"',
    );
    const result = safeFailure(error);
    expect(result).toEqual({
      errorName: 'PrismaClientKnownRequestError',
      prismaCode: 'P2003',
    });
    expect(JSON.stringify(result)).not.toContain('priya');
  });

  it('drops codes that are not Prisma codes', () => {
    const error = Object.assign(new Error('boom'), { code: 'priya@x.com' });
    expect(safeFailure(error)).toEqual({ errorName: 'Error' });
  });

  it('handles values that are not errors', () => {
    expect(safeFailure('priya@example.com')).toEqual({ errorName: 'Unknown' });
    expect(safeFailure(null)).toEqual({ errorName: 'Unknown' });
    expect(safeFailure(Object.create(null))).toEqual({ errorName: 'Unknown' });
  });
});
