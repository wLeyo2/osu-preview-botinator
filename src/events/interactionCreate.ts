import { Events, MessageFlags } from 'discord.js';
import { Cooldown } from '@/utils/cooldown';
import config from '@/utils/config';
import logger from '@/utils/logger';
import type { Event } from '@/utils/types/event';

const cooldown = new Cooldown(3);

export const event: Event<Events.InteractionCreate> = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.guildId && config.blockedGuilds.includes(interaction.guildId)) {
      await interaction.reply({
        content: 'This server is not allowed to use this bot.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (cooldown.check(interaction.user.id)) {
      const remaining = cooldown.getRemainingTime(interaction.user.id);

      await interaction.reply({
        content: `Please wait ${remaining}s before using the command again`,
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      logger.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    cooldown.set(interaction.user.id);

    try {
      await command.execute(interaction);
    } catch (error) {
      logger.error(error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: 'There was an error while executing this command.',
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: 'There was an error while executing this command.',
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // Interaction token already expired — nothing we can do
      }
    }
  },
};
