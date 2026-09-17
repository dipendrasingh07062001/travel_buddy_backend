const visibilityValues = ['PUBLIC', 'MEMBERS_ONLY', 'PRIVATE'] as const;

export const privateUserSchema = {
  type: 'object',
  required: [
    'id',
    'displayName',
    'birthDate',
    'status',
    'createdAt',
    'profile',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    birthDate: {
      anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
    },
    status: { type: 'string', enum: ['ACTIVE'] },
    createdAt: { type: 'string', format: 'date-time' },
    profile: {
      anyOf: [
        {
          type: 'object',
          required: [
            'profilePhotoAvailable',
            'homeCity',
            'homeRegion',
            'biography',
            'languages',
            'travelInterests',
            'pastTripsVisibility',
            'communityActivityVisibility',
          ],
          properties: {
            profilePhotoAvailable: { type: 'boolean' },
            homeCity: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            homeRegion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            biography: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            languages: { type: 'array', items: { type: 'string' } },
            travelInterests: { type: 'array', items: { type: 'string' } },
            pastTripsVisibility: { type: 'string', enum: visibilityValues },
            communityActivityVisibility: {
              type: 'string',
              enum: visibilityValues,
            },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

export const publicUserSchema = {
  type: 'object',
  required: [
    'id',
    'displayName',
    'ageRange',
    'accountCreatedMonth',
    'profilePhotoAvailable',
    'homeCity',
    'homeRegion',
    'biography',
    'languages',
    'travelInterests',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    displayName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    ageRange: {
      anyOf: [
        { type: 'string', enum: ['18-24', '25-34', '35-44', '45-54', '55+'] },
        { type: 'null' },
      ],
    },
    accountCreatedMonth: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
    profilePhotoAvailable: { type: 'boolean' },
    homeCity: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    homeRegion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    biography: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    languages: { type: 'array', items: { type: 'string' } },
    travelInterests: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const profileVisibilityValues = visibilityValues;
