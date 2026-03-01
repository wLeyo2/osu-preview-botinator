import { AttachmentBuilder, EmbedBuilder, Events } from 'discord.js';
import { uploadVideoToR2 } from '@/r2';
import logger from '@/utils/logger';
import { BEATMAP_URL_REGEX, SUPPORTED_MODES } from '@/utils/osu/constants';
import {
  cleanupVideo,
  encodeVideo,
  fetchCoverImage,
} from '@/utils/osu/encoder';
import {
  extractAudioFilename,
  fetchAudioFromOsz,
} from '@/utils/osu/fetchAudio';
import {
  extractPreviewTime,
  extractSetId,
  fetchBeatmap,
  parseOsuUrl,
} from '@/utils/osu/fetchBeatmap';
import { formatDuration, parseBeatmap } from '@/utils/osu/parseBeatmap';
import { getScrollMs } from '@/utils/osu/scrollSpeed';
import { renderStrainChart } from '@/utils/osu/strainChart';
import { getUserPrefs } from '@/utils/osu/userPrefs';
import type { Event } from '@/utils/types/event';

const UNSUPPORTED_GAMEMODE =
  'This beatmap mode is not supported. Only osu!standard and osu!mania are supported.';

/** Discord file size limit for bots without Nitro boost: 10 MB */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const event: Event<Events.MessageCreate> = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const match = message.content.match(BEATMAP_URL_REGEX);
    if (!match) return;

    const url = match[0];
    logger.info(`osu! link detected from ${message.author.tag}: ${url}`);

    let beatmapSetId: string;
    let beatmapId: string;

    try {
      ({ beatmapSetId, beatmapId } = parseOsuUrl(url));
    } catch (err) {
      await message.reply({
        content: err instanceof Error ? err.message : 'Invalid osu! URL.',
      });
      return;
    }

    await message.channel.sendTyping();

    try {
      // 1. Fetch the .osu file
      const rawBeatmap = await fetchBeatmap(beatmapId);

      if (!beatmapSetId) {
        beatmapSetId = extractSetId(rawBeatmap);
        if (!beatmapSetId) {
          await message.reply({
            content:
              'Could not determine the beatmapset ID. Please use a beatmapsets link.',
          });
          return;
        }
      }

      // 2. Parse — extract everything needed from rawBeatmap then let it go.
      // The string can be 100–500 KB and isn't needed past this point.
      const meta = parseBeatmap(rawBeatmap);
      const previewTime = extractPreviewTime(rawBeatmap);
      const audioFilename = extractAudioFilename(rawBeatmap);
      // rawBeatmap is now eligible for GC (no further references below)

      if (!SUPPORTED_MODES.includes(meta.mode)) {
        await message.reply({ content: UNSUPPORTED_GAMEMODE });
        return;
      }

      const userPrefs = getUserPrefs(message.author.id);
      const scrollMs = getScrollMs(message.author.id);

      // 3. Fetch audio + cover in parallel
      const [audio, coverImage] = await Promise.all([
        fetchAudioFromOsz(beatmapSetId, audioFilename),
        fetchCoverImage(beatmapSetId),
      ]);

      // 4. Encode video
      const videoPath = await encodeVideo(
        meta,
        audio,
        coverImage,
        previewTime,
        scrollMs,
        {
          noteStyle: userPrefs.noteStyle,
          noteColors: userPrefs.noteColors,
          noteColorSpecial: userPrefs.noteColorSpecial,
        },
        userPrefs.renderMode,
      );

      // 5. Render strain chart
      const chartBuffer = renderStrainChart(meta);

      // 6. Build embed
      const modeName = meta.mode === 3 ? 'osu!mania' : 'osu!standard';
      const keyInfo = meta.mode === 3 ? ` • ${meta.keys}K` : '';

      const embed = new EmbedBuilder()
        .setColor(0xe47fff)
        .setTitle(`${meta.artist} - ${meta.title}`)
        .setDescription(`**[${meta.version}]** — mapped by ${meta.creator}`)
        .addFields(
          { name: 'Mode', value: `${modeName}${keyInfo}`, inline: true },
          {
            name: 'Star Rating',
            value: `${meta.stars.toFixed(2)} ★`,
            inline: true,
          },
          {
            name: 'Duration',
            value: formatDuration(meta.drainSeconds),
            inline: true,
          },
          { name: 'HP Drain', value: `${meta.hp.toFixed(1)}`, inline: true },
          {
            name: 'Overall Difficulty',
            value: `${meta.od.toFixed(1)}`,
            inline: true,
          },
          { name: 'BPM', value: `${Math.round(meta.bpm)}`, inline: true },
        )
        // Attach strain chart image — Discord renders attachments referenced by
        // attachment:// URL inside embeds
        .setImage('attachment://strain.png')
        .setFooter({
          text: `osu!preview-botinator • scroll: ${scrollMs} ms • render: ${userPrefs.renderMode}`,
        });

      if (coverImage) {
        embed.setThumbnail(
          `https://assets.ppy.sh/beatmaps/${beatmapSetId}/covers/cover@2x.jpg`,
        );
      }

      const { stat } = await import('node:fs/promises');
      const { size } = await stat(videoPath);

      const chartAttachment = new AttachmentBuilder(chartBuffer, {
        name: 'strain.png',
      });

      if (size > MAX_FILE_BYTES) {
        const fileName = `preview_${beatmapId}.mp4`;
        const videoUrl = await uploadVideoToR2(videoPath, fileName);

        if (videoUrl) {
          embed.setURL(videoUrl);
          await message.reply({
            content: `Video too large for direct upload (${(size / 1024 / 1024).toFixed(1)} MB).`,
            embeds: [embed],
            files: [chartAttachment],
          });
          await message.channel.send(videoUrl).catch(() => {});
        } else {
          await message.reply({
            content: `Failed to upload video to R2 (${(size / 1024 / 1024).toFixed(1)} MB > ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
            embeds: [embed],
            files: [chartAttachment],
          });
        }

        await cleanupVideo(videoPath);
        return;
      }

      const videoAttachment = new AttachmentBuilder(videoPath, {
        name: 'preview.mp4',
      });

      await message.reply({
        embeds: [embed],
        files: [videoAttachment, chartAttachment],
      });

      await cleanupVideo(videoPath);
    } catch (err) {
      logger.error(err);
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      await message
        .reply({ content: `Failed to generate preview: ${msg}` })
        .catch(() => {});
    }
  },
};
