/**
 * Engine smoke test: renders a preview video without Discord/queue/R2.
 * Usage: bun scripts/test-render.ts [beatmap-url]
 * Requires only ffmpeg; config secrets can be dummy values.
 */
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cleanupVideo, encodeVideo } from '@/utils/osu/encoder';
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
import { parseBeatmap } from '@/utils/osu/parseBeatmap';

const url =
  process.argv[2] ?? 'https://osu.ppy.sh/beatmapsets/2356548#mania/5074941';

const start = performance.now();
const { beatmapSetId: setIdHint, beatmapId } = parseOsuUrl(url);
const raw = await fetchBeatmap(beatmapId);
const meta = parseBeatmap(raw);
const beatmapSetId = setIdHint || extractSetId(raw);

const audioTask = fetchAudioFromOsz(beatmapSetId, extractAudioFilename(raw));
const videoPath = await encodeVideo(
  meta,
  audioTask,
  extractPreviewTime(raw),
  500,
  {},
  'last4min',
);

const outPath = `preview-${beatmapId}.mp4`;
await fs.copyFile(videoPath, outPath);
await cleanupVideo(videoPath);

const totalSec = ((performance.now() - start) / 1000).toFixed(1);
console.log(
  `done: ${outPath} in ${totalSec}s (mode=${meta.mode}, rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB)`,
);
