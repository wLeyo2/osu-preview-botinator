import { Client, GatewayIntentBits } from 'discord.js';

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

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  logger.error(error);
});
