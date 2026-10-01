import { AppError } from '../../errors/app-error.js';
import type {
  CommunityMetadata,
  CommunityMetadataPatch,
} from './community-admin.repository.js';

export interface CommunityMetadataBody {
  name?: string;
  region?: string | null;
  countryCode?: string;
  description?: string | null;
}

export interface CreateCommunityBody extends CommunityMetadataBody {
  slug: string;
  name: string;
}

export function cleanSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
    throw new AppError(
      400,
      'INVALID_COMMUNITY_SLUG',
      'Use a lowercase URL slug containing letters, numbers and single hyphens.',
    );
  }
  return slug;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length < 2 || name.length > 120) {
    throw new AppError(
      400,
      'INVALID_COMMUNITY_NAME',
      'A community name must contain 2 to 120 characters.',
    );
  }
  return name;
}

function cleanRegion(raw: string | null): string | null {
  if (raw === null) return null;
  const region = raw.trim();
  if (region.length < 2 || region.length > 120) {
    throw new AppError(
      400,
      'INVALID_COMMUNITY_REGION',
      'A region must contain 2 to 120 characters, or be null.',
    );
  }
  return region;
}

function cleanCountryCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new AppError(
      400,
      'INVALID_COUNTRY_CODE',
      'Use a two-letter country code.',
    );
  }
  return code;
}

function cleanDescription(raw: string | null): string | null {
  if (raw === null) return null;
  const description = raw.trim();
  if (description.length > 2000) {
    throw new AppError(
      400,
      'INVALID_COMMUNITY_DESCRIPTION',
      'A description cannot exceed 2000 characters.',
    );
  }
  return description || null;
}

export function cleanCreateMetadata(
  body: CreateCommunityBody,
): CommunityMetadata {
  return {
    name: cleanName(body.name),
    region: body.region === undefined ? null : cleanRegion(body.region),
    countryCode: cleanCountryCode(body.countryCode ?? 'IN'),
    description:
      body.description === undefined
        ? null
        : cleanDescription(body.description),
  };
}

export function cleanMetadataPatch(
  body: CommunityMetadataBody,
): CommunityMetadataPatch {
  const patch: CommunityMetadataPatch = {};
  if (body.name !== undefined) patch.name = cleanName(body.name);
  if (body.region !== undefined) patch.region = cleanRegion(body.region);
  if (body.countryCode !== undefined)
    patch.countryCode = cleanCountryCode(body.countryCode);
  if (body.description !== undefined)
    patch.description = cleanDescription(body.description);
  if (Object.keys(patch).length === 0) {
    throw new AppError(
      400,
      'NO_COMMUNITY_CHANGES',
      'Provide at least one community field to update.',
    );
  }
  return patch;
}

export function cleanAdminReason(raw: string): string {
  const reason = raw.trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new AppError(
      400,
      'INVALID_ADMIN_REASON',
      'An administrative reason must contain 10 to 1000 non-space characters.',
    );
  }
  return reason;
}
