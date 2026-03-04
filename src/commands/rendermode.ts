import { SlashCommandBuilder } from 'discord.js';
import type { RenderMode } from '@/utils/osu/userPrefs';
import {
  getUserPrefs,
  RENDER_MODE_DEFAULT,
  STRAIN_OVERLAY_DEFAULT,
  setRenderMode,
  setStrainOverlay,
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
    .setDescription('Set long-map render mode and strain footer visibility')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Render window mode')
        .addChoices(
          { name: 'Last 4 minutes (default)', value: 'last4min' },
          { name: 'Around preview point', value: 'preview' },
        ),
    )
    .addBooleanOption((opt) =>
      opt
        .setName('strain')
        .setDescription('Show the subtle strain chart in the footer'),
    ),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const prefs = getUserPrefs(userId);
    const modeInput = interaction.options.getString(
      'mode',
    ) as RenderMode | null;
    const strainInput = interaction.options.getBoolean('strain');

    // No option — show current setting
    if (!modeInput && strainInput === null) {
      const current = prefs.renderMode ?? RENDER_MODE_DEFAULT;
      const strainOverlay = prefs.strainOverlay ?? STRAIN_OVERLAY_DEFAULT;
      await interaction.editReply(
        `Your render mode: **${current}** — ${MODE_DESCRIPTIONS[current]}\n` +
          `Strain footer: **${strainOverlay ? 'on' : 'off'}**\n` +
          `Use \`/rendermode mode:\` and/or \`/rendermode strain:\` to change.`,
      );
      return;
    }

    const updates: string[] = [];

    if (modeInput) {
      setRenderMode(userId, modeInput);
      updates.push(
        `Render mode: **${modeInput}** — ${MODE_DESCRIPTIONS[modeInput]}`,
      );
    }

    if (strainInput !== null) {
      setStrainOverlay(userId, strainInput);
      updates.push(`Strain footer: **${strainInput ? 'on' : 'off'}**`);
    }

    await interaction.editReply(updates.join('\n'));
  },
};
