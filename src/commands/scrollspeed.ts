import { SlashCommandBuilder } from 'discord.js';
import { DEFAULT_SCROLL_MS } from '@/utils/osu/renderer';
import {
  getScrollMs,
  SCROLL_MS_MAX,
  SCROLL_MS_MIN,
  SPEED_PRESETS,
  setScrollMs,
} from '@/utils/osu/scrollSpeed';
import type { Command } from '@/utils/types/command';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('scrollspeed')
    .setDescription(
      'Set the mania note scroll speed for previews in this server',
    )
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('Speed preset')
        .addChoices(
          { name: 'Very Fast', value: 'very fast' },
          { name: 'Fast', value: 'fast' },
          { name: 'Normal (default)', value: 'normal' },
          { name: 'Slow', value: 'slow' },
          { name: 'Very Slow', value: 'very slow' },
        ),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('ms')
        .setDescription(
          `Custom visible window in ms (${SCROLL_MS_MIN}–${SCROLL_MS_MAX}). Lower = faster.`,
        )
        .setMinValue(SCROLL_MS_MIN)
        .setMaxValue(SCROLL_MS_MAX),
    ),
  async execute(interaction) {
    // Defer immediately — keeps the token alive while we process
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply('This command can only be used in a server.');
      return;
    }

    const preset = interaction.options.getString('preset');
    const customMs = interaction.options.getInteger('ms');

    // No option given — show current
    if (!preset && !customMs) {
      const current = getScrollMs(guildId);
      await interaction.editReply(
        `Current scroll speed: **${current} ms** (${speedLabel(current)}). Lower = faster notes.\nUse \`/scrollspeed preset:\` or \`/scrollspeed ms:\` to change.`,
      );
      return;
    }

    let newMs: number;

    if (customMs) {
      newMs = customMs;
    } else if (preset && preset in SPEED_PRESETS) {
      newMs = SPEED_PRESETS[preset] ?? DEFAULT_SCROLL_MS;
    } else {
      newMs = DEFAULT_SCROLL_MS;
    }

    setScrollMs(guildId, newMs);

    await interaction.editReply(
      `Scroll speed set to **${newMs} ms** (${speedLabel(newMs)}) for this server.`,
    );
  },
};

function speedLabel(ms: number): string {
  if (ms <= 600) return 'very fast';
  if (ms <= 1000) return 'fast';
  if (ms <= 2000) return 'normal';
  if (ms <= 3000) return 'slow';
  return 'very slow';
}
