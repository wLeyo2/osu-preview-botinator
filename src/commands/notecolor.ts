import { SlashCommandBuilder } from 'discord.js';
import {
  getUserPrefs,
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
        .setName('primary')
        .setDescription('Primary note color — outer columns (hex #RRGGBB)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('accent')
        .setDescription(
          'Accent note color — inner alternating columns (hex #RRGGBB)',
        )
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
      [interaction.options.getString('primary') ?? '', 0],
      [interaction.options.getString('accent') ?? '', 1],
      [interaction.options.getString('special') ?? '', 'special'],
    ];

    const provided = inputs.filter(([hex]) => hex !== '');

    // No options given — show current colors
    if (provided.length === 0) {
      const prefs = await getUserPrefs(userId);
      const cols = prefs.noteColors;
      const lines = [
        `**Your current note colors:**`,
        `primary: \`${cols[0] ?? NOTE_COLORS_DEFAULT[0]}\` (outer columns)`,
        `accent: \`${cols[1] ?? NOTE_COLORS_DEFAULT[1]}\` (inner columns)`,
        `special: \`${prefs.noteColorSpecial}\` (center column on odd-key maps)`,
        ``,
        `Use \`/notecolor primary:#RRGGBB\` to change individual colors.`,
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
      await setNoteColor(userId, colIndex, hex.toLowerCase());
    }

    const updated = provided
      .map(
        ([hex, idx]) =>
          `${idx === 'special' ? 'special' : idx === 0 ? 'primary' : 'accent'}: \`${hex}\``,
      )
      .join('\n');

    await interaction.editReply(
      `Note colors updated:\n${updated}\n\nYour next preview will use these colors.`,
    );
  },
};
