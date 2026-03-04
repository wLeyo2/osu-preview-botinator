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
    .setDescription('Set your personal mania note scroll speed for previews')
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('Speed preset')
        .addChoices(
          { name: 'Fast', value: 'fast' },
          { name: 'Medium (default)', value: 'medium' },
          { name: 'Slow', value: 'slow' },
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
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const preset = interaction.options.getString('preset');
    const customMs = interaction.options.getInteger('ms');

    // No option given — show current
    if (!preset && !customMs) {
      const current = await getScrollMs(userId);
      await interaction.editReply(
        `Your scroll speed: **${current} ms** (${speedLabel(current)}). Lower = faster notes.\nUse \`/scrollspeed preset:\` or \`/scrollspeed ms:\` to change.`,
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

    await setScrollMs(userId, newMs);

    await interaction.editReply(
      `Scroll speed set to **${newMs} ms** (${speedLabel(newMs)}).`,
    );
  },
};

function speedLabel(ms: number): string {
  if (ms <= 350) return 'fast';
  if (ms <= 600) return 'medium';
  return 'slow';
}
