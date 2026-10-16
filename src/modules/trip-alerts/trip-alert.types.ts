import type {
  TripAlertSubscription,
  TripTransport,
} from '../../generated/prisma/client.js';

export interface TripAlertBody {
  name: string;
  communityId: string;
  enabled: boolean;
  origin?: string;
  departureFrom?: string;
  departureTo?: string;
  minBudget?: number;
  maxBudget?: number;
  minDuration?: number;
  maxDuration?: number;
  transport?: TripTransport;
}

export interface TripAlertInput {
  name: string;
  communityId: string;
  enabled: boolean;
  origin: string | null;
  departureFrom: Date | null;
  departureTo: Date | null;
  minBudget: number | null;
  maxBudget: number | null;
  minDuration: number | null;
  maxDuration: number | null;
  transport: TripTransport | null;
}

export interface TripAlertRepository {
  list(userId: string): Promise<TripAlertSubscription[]>;
  create(userId: string, input: TripAlertInput): Promise<TripAlertSubscription>;
  replace(
    userId: string,
    id: string,
    version: number,
    input: TripAlertInput,
  ): Promise<TripAlertSubscription>;
  remove(userId: string, id: string): Promise<void>;
}

export interface TripAlertDependencies {
  repository: TripAlertRepository;
}
