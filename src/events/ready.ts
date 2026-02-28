import { type Client, Events } from 'discord.js';
import logger from '@/utils/logger';
import type { Event } from '@/utils/types/event';

export const event: Event<Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,

  execute(client: Client<true>) {
    const totalUsers = client.guilds.cache.reduce(
      (a, g) => a + g.memberCount,
      0,
    );

    logger.info(`${client.user.tag}`);
    logger.info(
      `Servers: ${client.guilds.cache.size} | Users: ${totalUsers} | Commands: ${client.commands.size}`,
    );
    logger.debug(`Latency: ${client.ws.ping} ms`);
  },
};
