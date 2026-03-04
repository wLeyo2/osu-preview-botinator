import { SlashCommandBuilder } from 'discord.js';
import type { NoteStyle } from '@/utils/osu/userPrefs';
import {
  getUserPrefs,
  resetUserPrefs,
  setNoteStyle,
} from '@/utils/osu/userPrefs';
import type { Command } from '@/utils/types/command';

const STYLE_DESCRIPTIONS: Record<NoteStyle, string> = {
  bar: 'Rounded rectangle bars (default)',
  circle: 'Circular notes with inner ring',
  arrow: 'Downward-pointing chevron arrows',
};

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('notestyle')
    .setDescription('Set your personal note shape style for mania previews')
    .addStringOption((opt) =>
      opt
        .setName('style')
        .setDescription('Note shape to use')
        .setRequired(false)
        .addChoices(
          { name: 'Bar — rounded rectangles (default)', value: 'bar' },
          { name: 'Circle — circular notes', value: 'circle' },
          { name: 'Arrow — chevron arrows', value: 'arrow' },
        ),
    )
    .addBooleanOption((opt) =>
      opt
        .setName('reset')
        .setDescription('Reset all your note preferences to default')
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const style = interaction.options.getString('style') as NoteStyle | null;
    const doReset = interaction.options.getBoolean('reset') ?? false;

    if (doReset) {
      await resetUserPrefs(userId);
      await interaction.editReply(
        'Your note preferences have been reset to default.',
      );
      return;
    }

    if (!style) {
      const prefs = await getUserPrefs(userId);
      const desc = STYLE_DESCRIPTIONS[prefs.noteStyle];
      await interaction.editReply(
        `Your current note style: **${prefs.noteStyle}** — ${desc}\nUse \`/notestyle style:\` to change it.`,
      );
      return;
    }

    await setNoteStyle(userId, style);
    await interaction.editReply(
      `Note style set to **${style}** — ${STYLE_DESCRIPTIONS[style]}. Your next preview will use this style.`,
    );
  },
};
