import { SlashCommandBuilder } from 'discord.js';
import type { ScrollDirection } from '@/utils/osu/userPrefs';
import {
  getUserPrefs,
  SCROLL_DIRECTION_DEFAULT,
  setScrollDirection,
} from '@/utils/osu/userPrefs';
import type { Command } from '@/utils/types/command';

const DIRECTION_DESCRIPTIONS: Record<ScrollDirection, string> = {
  down: 'Notes fall downward toward the hit line at the bottom (default, matches osu!mania)',
  up: 'Notes rise upward toward the hit line at the top',
};

const DIRECTION_LABELS: Record<ScrollDirection, string> = {
  down: '↓ Downscroll',
  up: '↑ Upscroll',
};

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('scrolldirection')
    .setDescription(
      'Set whether notes fall downward or rise upward toward the hit line',
    )
    .addStringOption((opt) =>
      opt
        .setName('direction')
        .setDescription('Scroll direction')
        .addChoices(
          { name: '↓ Downscroll (default)', value: 'down' },
          { name: '↑ Upscroll', value: 'up' },
        ),
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const dirInput = interaction.options.getString(
      'direction',
    ) as ScrollDirection | null;

    // No option — show current setting
    if (!dirInput) {
      const current =
        (await getUserPrefs(userId)).scrollDirection ??
        SCROLL_DIRECTION_DEFAULT;
      await interaction.editReply(
        `Your scroll direction: **${DIRECTION_LABELS[current]}** — ${DIRECTION_DESCRIPTIONS[current]}\n` +
          `Use \`/scrolldirection direction:\` to change.`,
      );
      return;
    }

    await setScrollDirection(userId, dirInput);

    await interaction.editReply(
      `Scroll direction set to **${DIRECTION_LABELS[dirInput]}** — ${DIRECTION_DESCRIPTIONS[dirInput]}`,
    );
  },
};
