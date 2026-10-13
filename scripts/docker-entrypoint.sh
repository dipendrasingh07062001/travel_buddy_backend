#!/bin/sh
set -e

# Apply committed migrations before the API starts. `prisma migrate deploy`
# only applies committed migrations and holds a database lock while it runs,
# so instances starting together cannot apply the same migration twice.
# Set RUN_MIGRATIONS=false when a separate release step applies them.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  ./node_modules/.bin/prisma migrate deploy
fi

# exec replaces the shell so Node receives SIGTERM and shuts down gracefully.
exec node dist/server.js
