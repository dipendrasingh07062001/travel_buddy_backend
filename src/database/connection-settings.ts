// Connection settings that Prisma 6 read from DATABASE_URL. node-postgres does
// not understand them, so they are removed from the URL and the ones that
// still matter are translated into pool and adapter options.
const prismaOnlyParameters = [
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'schema',
  'socket_timeout',
  'statement_cache_size',
  'connect_timeout',
];

// Prisma 6 gave up on a new connection after 5 seconds; node-postgres would
// otherwise wait forever.
const defaultConnectTimeoutSeconds = 5;

export interface PostgresSettings {
  connectionString: string;
  connectionTimeoutMillis: number;
  max?: number;
  schema?: string;
}

function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

export function postgresConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const parameter of prismaOnlyParameters) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
}

export function postgresSettings(databaseUrl: string): PostgresSettings {
  const parameters = new URL(databaseUrl).searchParams;
  const max = positiveInteger(parameters.get('connection_limit'));
  const schema = parameters.get('schema');
  return {
    connectionString: postgresConnectionString(databaseUrl),
    connectionTimeoutMillis:
      (positiveInteger(parameters.get('connect_timeout')) ??
        defaultConnectTimeoutSeconds) * 1000,
    ...(max !== undefined && { max }),
    ...(schema && { schema }),
  };
}
