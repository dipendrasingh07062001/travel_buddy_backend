import type { Prisma } from '@prisma/client';

import { database } from '../../database/client.js';
import {
  publicTripInclude,
  publicTripStatuses,
  type TripRepository,
} from './trip.types.js';

function dateAtUtcMidnight(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export const prismaTripRepository: TripRepository = {
  async listPublic(query) {
    const where: Prisma.TripWhereInput = {
      status: { in: [...publicTripStatuses] },
      community: { status: 'ACTIVE' },
      ...(query.origin && {
        originCity: { contains: query.origin, mode: 'insensitive' },
      }),
      ...(query.destination && {
        community: { status: 'ACTIVE', slug: query.destination },
      }),
      ...(query.departureFrom && {
        endDate: { gte: dateAtUtcMidnight(query.departureFrom) },
      }),
      ...(query.departureTo && {
        startDate: { lte: dateAtUtcMidnight(query.departureTo) },
      }),
      ...(query.minBudget !== undefined && {
        budgetMax: { gte: query.minBudget },
      }),
      ...(query.maxBudget !== undefined && {
        budgetMin: { lte: query.maxBudget },
      }),
      ...(query.transport && { transport: query.transport }),
    };
    const orderBy: Prisma.TripOrderByWithRelationInput[] =
      query.sort === 'departure_asc'
        ? [{ startDate: 'asc' }, { id: 'asc' }]
        : [{ publishedAt: 'desc' }, { id: 'asc' }];

    const [trips, totalItems] = await database.$transaction([
      database.trip.findMany({
        where,
        include: publicTripInclude,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      database.trip.count({ where }),
    ]);

    return { trips, totalItems };
  },

  findPublicById(id) {
    return database.trip.findFirst({
      where: {
        id,
        status: { in: [...publicTripStatuses] },
        community: { status: 'ACTIVE' },
      },
      include: publicTripInclude,
    });
  },
};
