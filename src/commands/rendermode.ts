import { SlashCommandBuilder } from 'discord.js';
import type { RenderMode } from '@/utils/osu/userPrefs';
import {
  getUserPrefs,
  RENDER_MODE_DEFAULT,
  setRenderMode,
} from '@/utils/osu/userPrefs';
import type { Command } from '@/utils/types/command';

const MODE_DESCRIPTIONS: Record<RenderMode, string> = {
  last4min: 'Render the last 4 minutes of the map (default)',
  preview:
    "Centre the 4-minute window on the beatmap's preview point (clamped to note boundaries)",
};

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('rendermode')
    .setDescription(
      'Set how long maps (>4 min drain) are rendered — last 4 min or around the preview point',
    )
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Render window mode')
        .addChoices(
          { name: 'Last 4 minutes (default)', value: 'last4min' },
          { name: 'Around preview point', value: 'preview' },
        ),
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const modeInput = interaction.options.getString(
      'mode',
    ) as RenderMode | null;

    // No option — show current setting
    if (!modeInput) {
      const current = getUserPrefs(userId).renderMode ?? RENDER_MODE_DEFAULT;
      await interaction.editReply(
        `Your render mode: **${current}** — ${MODE_DESCRIPTIONS[current]}\n` +
          `Use \`/rendermode mode:\` to change.`,
      );
      return;
    }

    setRenderMode(userId, modeInput);

    await interaction.editReply(
      `Render mode set to **${modeInput}** — ${MODE_DESCRIPTIONS[modeInput]}`,
    );
  },
};
