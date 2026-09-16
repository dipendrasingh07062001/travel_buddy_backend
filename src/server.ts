import { buildApp } from './app.js';
import { env } from './config/env.js';
import { database } from './database/client.js';

const app = buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');

  try {
    await app.close();
    await database.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal({ error }, 'API failed to start');
  await database.$disconnect();
  process.exit(1);
}
