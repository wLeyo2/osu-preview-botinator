import { SlashCommandBuilder } from 'discord.js';
import {
  getUserPrefs,
  NOTE_COLOR_SPECIAL_DEFAULT,
  NOTE_COLORS_DEFAULT,
  setNoteColor,
} from '@/utils/osu/userPrefs';
import type { Command } from '@/utils/types/command';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(hex: string): boolean {
  return HEX_RE.test(hex);
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('notecolor')
    .setDescription('Set your personal note colors for mania previews')
    .addStringOption((opt) =>
      opt
        .setName('col1')
        .setDescription('Color for columns 1, 5, 9… (hex #RRGGBB)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('col2')
        .setDescription('Color for columns 2, 6, 10… (hex #RRGGBB)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('col3')
        .setDescription('Color for columns 3, 7, 11… (hex #RRGGBB)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('col4')
        .setDescription('Color for columns 4, 8, 12… (hex #RRGGBB)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('special')
        .setDescription('Center column color for odd-key maps (hex #RRGGBB)')
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    const inputs: Array<[string, number | 'special']> = [
      [interaction.options.getString('col1') ?? '', 0],
      [interaction.options.getString('col2') ?? '', 1],
      [interaction.options.getString('col3') ?? '', 2],
      [interaction.options.getString('col4') ?? '', 3],
      [interaction.options.getString('special') ?? '', 'special'],
    ];

    const provided = inputs.filter(([hex]) => hex !== '');

    // No options given — show current colors
    if (provided.length === 0) {
      const prefs = getUserPrefs(userId);
      const cols = prefs.noteColors;
      const lines = [
        `**Your current note colors:**`,
        `col1: \`${cols[0] ?? NOTE_COLORS_DEFAULT[0]}\``,
        `col2: \`${cols[1] ?? NOTE_COLORS_DEFAULT[1]}\``,
        `col3: \`${cols[2] ?? NOTE_COLORS_DEFAULT[2]}\``,
        `col4: \`${cols[3] ?? NOTE_COLORS_DEFAULT[3]}\``,
        `special: \`${prefs.noteColorSpecial}\``,
        ``,
        `Use \`/notecolor col1:#RRGGBB\` to change individual columns.`,
      ];
      await interaction.editReply(lines.join('\n'));
      return;
    }

    const invalid = provided.filter(([hex]) => !isValidHex(hex));
    if (invalid.length > 0) {
      await interaction.editReply(
        `Invalid hex color(s): ${invalid.map(([h]) => `\`${h}\``).join(', ')}\nUse the format \`#RRGGBB\`, e.g. \`#ff4488\`.`,
      );
      return;
    }

    for (const [hex, colIndex] of provided) {
      setNoteColor(userId, colIndex, hex.toLowerCase());
    }

    const prefs = getUserPrefs(userId);
    const updated = provided
      .map(
        ([hex, idx]) =>
          `${idx === 'special' ? 'special' : `col${(idx as number) + 1}`}: \`${hex}\``,
      )
      .join('\n');

    await interaction.editReply(
      `Note colors updated:\n${updated}\n\nYour next preview will use these colors.`,
    );
  },
};
