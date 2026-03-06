import { Client, GatewayIntentBits } from 'discord.js';
import { preflightRedisConnection } from '@/queue/connection';
import { stopQueueNotifier } from '@/queue/notifier';
import { closeStoreConnection } from '@/queue/store';
import { stopQueueTelemetry } from '@/queue/telemetry';
import { closeQueueClients } from '@/queue/videoQueue';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { loadCommands } from './utils/loaders/commands';
import { loadEvents } from './utils/loaders/events';

const botLogger = logger.child({ service: 'bot' });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to read message text for link detection
  ],
});

(async () => {
  try {
    await preflightRedisConnection('redis-bot-preflight');
    await loadCommands(client, './src/commands');
    await loadEvents(client, './src/events');
    await client.login(config.token);
  } catch (error) {
    botLogger.error(error);
    await shutdown('BOOT_FAILURE', 1);
  }
})();

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  botLogger.info({ signal }, 'Shutting down gracefully');
  stopQueueNotifier();
  stopQueueTelemetry();
  await Promise.allSettled([
    closeQueueClients(),
    closeStoreConnection(),
    Promise.resolve(client.destroy()),
  ]);
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  botLogger.error(error);
});
