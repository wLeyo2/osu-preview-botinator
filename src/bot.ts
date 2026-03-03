import { Client, GatewayIntentBits } from 'discord.js';
import { stopQueueNotifier } from '@/queue/notifier';
import { closeStoreConnection } from '@/queue/store';
import { closeQueueClients } from '@/queue/videoQueue';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { loadCommands } from './utils/loaders/commands';
import { loadEvents } from './utils/loaders/events';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to read message text for link detection
  ],
});

(async () => {
  await loadCommands(client, './src/commands');
  await loadEvents(client, './src/events');

  await client.login(config.token).catch((error) => logger.error(error));
})();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Shutting down gracefully (${signal})...`);
  stopQueueNotifier();
  await Promise.allSettled([
    closeQueueClients(),
    closeStoreConnection(),
    Promise.resolve(client.destroy()),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  logger.error(error);
});
