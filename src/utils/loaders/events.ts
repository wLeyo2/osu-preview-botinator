import type { Client } from 'discord.js';
import logger from '@/utils/logger';
import { getAllFiles } from './getAllFiles';

export const loadEvents = async (client: Client, dir: string) => {
  const eventFiles = getAllFiles(dir);

  for (const file of eventFiles) {
    const { event } = await import(file);

    if ('name' in event && 'execute' in event) {
      if (event.once) {
        client.once(event.name, (...args) => {
          Promise.resolve(event.execute(...args)).catch((err) =>
            logger.error(err),
          );
        });
      } else {
        client.on(event.name, (...args) => {
          Promise.resolve(event.execute(...args)).catch((err) =>
            logger.error(err),
          );
        });
      }
    } else {
      logger.warn(`invalid event file: ${file}`);
    }
  }
};
