import { publicText } from '../../privacy/public-text.js';
import { presentPublicDestination } from '../communities/community.presenter.js';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

// A community as shown on posts and comments: always a real hub.
export const communityDestinationSchema = {
  type: 'object',
  required: ['id', 'slug', 'name', 'region', 'countryCode'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    region: nullableString,
    countryCode: { type: 'string' },
  },
} as const;

// A trip's destination: a linked community, or a typed name whose community
// fields are null.
export const tripDestinationSchema = {
  type: 'object',
  required: ['id', 'slug', 'name', 'region', 'countryCode'],
  properties: {
    id: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    slug: nullableString,
    name: { type: 'string' },
    region: nullableString,
    countryCode: nullableString,
  },
} as const;

// No minLength: an empty name must reach the service, which answers
// INVALID_DESTINATION instead of a generic schema error.
export const destinationNameProperty = {
  type: 'string',
  maxLength: 120,
  description:
    'A typed destination when no community is selected. Send exactly one of communityId or destinationName. A name equal to one active community (ignoring case) links that community.',
} as const;

interface DestinationCommunity {
  id: string;
  slug: string;
  name: string;
  region: string | null;
  countryCode: string;
}

export interface TripDestinationSource {
  community: DestinationCommunity | null;
  destinationName: string | null;
}

/** `original` returns stored text for the owner and members, unmasked. */
export function presentTripDestination(
  trip: TripDestinationSource,
  { original = false }: { original?: boolean } = {},
) {
  if (trip.community) {
    return original
      ? {
          ...trip.community,
          countryCode: trip.community.countryCode.trim(),
        }
      : presentPublicDestination(trip.community);
  }
  // The CHECK constraint guarantees a name when no community is linked.
  const name = trip.destinationName ?? '';
  return {
    id: null,
    slug: null,
    name: original ? name : publicText(name),
    region: null,
    countryCode: null,
  };
}
