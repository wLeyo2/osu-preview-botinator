import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import ffmpeg from 'fluent-ffmpeg';
import config from '@/utils/config';
import logger from '@/utils/logger';
import type { AudioResult } from './fetchAudio';
import type { BeatmapMeta } from './parseBeatmap';
import type { RenderOptions } from './renderer';
import {
  DEFAULT_SCROLL_MS,
  FPS,
  renderFrames,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from './renderer';
import type { RenderMode } from './userPrefs';

/** Hard cap on rendered video length. Maps longer than this show only the last 4 minutes. */
const MAX_RENDER_MS = 240_000; // 4 minutes

/** Extra time rendered after the last note so the video doesn't end abruptly. */
const TAIL_MS = 1000;

/**
 * Encodes a mania preview video and returns the path to the temporary file.
 *
 * Short maps (≤ 4 min drain): starts 1 s before the first note, renders everything.
 * Long maps (> 4 min drain):
 *   - renderMode 'last4min' (default): renders the final 4 minutes.
 *   - renderMode 'preview': centres the 4-minute window on the beatmap's
 *     preview point, clamped so the window stays within the note range.
 *
 * @param meta         Parsed beatmap metadata
 * @param audio        Audio data extracted from the .osz
 * @param coverImage   Cover image buffer (optional)
 * @param previewTime  Beatmap preview point in ms (used for audio seek + preview mode)
 * @param scrollMs     Visible note window in ms (controls scroll speed)
 * @param renderOpts   Per-user note style/colour overrides
 * @param renderMode   Window selection mode for long maps
 * @returns            Absolute path to the output .mp4 file
 */
export async function encodeVideo(
  meta: BeatmapMeta,
  audio: AudioResult,
  coverImage: Buffer | null,
  previewTime: number,
  scrollMs = DEFAULT_SCROLL_MS,
  renderOpts: RenderOptions = {},
  renderMode: RenderMode = 'last4min',
): Promise<string> {
  const firstNoteMs = meta.notes[0]?.startTime ?? 0;
  const lastNoteMs =
    meta.notes.at(-1)?.endTime ?? meta.notes.at(-1)?.startTime ?? firstNoteMs;
  const drainMs =
    meta.drainSeconds > 0 ? meta.drainSeconds * 1000 : MAX_RENDER_MS;

  let videoMapStartMs: number;
  let durationMs: number;

  if (drainMs <= MAX_RENDER_MS) {
    // Short map: start 1 s before first note, render the whole thing + tail
    videoMapStartMs = Math.max(0, firstNoteMs - 1000);
    durationMs = drainMs + TAIL_MS;
  } else if (renderMode === 'preview') {
    // Centre the window on the preview point, clamped to note boundaries so we
    // never render empty seconds just to honour the centre position.
    const halfWindow = MAX_RENDER_MS / 2;
    const idealStart = previewTime - halfWindow;
    // Clamp: window must not start before firstNoteMs or end after lastNoteMs
    const clampedStart = Math.max(
      firstNoteMs,
      Math.min(idealStart, lastNoteMs - MAX_RENDER_MS),
    );
    videoMapStartMs = clampedStart;
    durationMs = MAX_RENDER_MS + TAIL_MS;
  } else {
    // 'last4min': render the final 4 minutes + tail
    videoMapStartMs = Math.max(0, lastNoteMs - MAX_RENDER_MS);
    durationMs = MAX_RENDER_MS + TAIL_MS;
  }

  const audioSeekMs = videoMapStartMs;

  const outPath = join(tmpdir(), `osu-preview-${randomUUID()}.mp4`);
  const audioPath = join(tmpdir(), `osu-audio-${randomUUID()}${audio.ext}`);

  await fs.writeFile(audioPath, audio.buffer);
  // Drop the reference so the GC can reclaim the audio buffer (can be tens of MB)
  // before the potentially long encode begins.
  (audio as { buffer: Buffer | null }).buffer = null;

  try {
    await runFfmpeg(
      meta,
      coverImage,
      videoMapStartMs,
      durationMs,
      audioSeekMs,
      audioPath,
      outPath,
      scrollMs,
      renderOpts,
    );
  } finally {
    await fs.unlink(audioPath).catch(() => {});
  }

  logger.info(`Video encoded: ${outPath}`);
  return outPath;
}

function runFfmpeg(
  meta: BeatmapMeta,
  coverImage: Buffer | null,
  videoMapStartMs: number,
  durationMs: number,
  audioSeekMs: number,
  audioPath: string,
  outPath: string,
  scrollMs: number,
  renderOpts: RenderOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const videoStream = new PassThrough();

    const command = ffmpeg()
      .input(videoStream as unknown as string)
      .inputOptions([
        '-f rawvideo',
        '-pixel_format rgba',
        `-video_size ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,
        `-framerate ${FPS}`,
      ])
      .input(audioPath)
      .inputOptions([`-ss ${(audioSeekMs / 1000).toFixed(3)}`])
      .outputOptions([
        '-c:v libx264',
        `-threads ${config.render.ffmpegThreads}`,
        '-preset ultrafast',
        '-crf 28',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 128k',
        `-t ${(durationMs / 1000).toFixed(3)}`,
        '-movflags +faststart',
      ])
      .output(outPath)
      .on('start', (cmd: string) => logger.debug(`ffmpeg: ${cmd}`))
      .on('error', (err: Error) => {
        logger.error(`ffmpeg error: ${err.message}`);
        reject(err);
      })
      .on('end', () => resolve());

    command.run();

    renderFrames(
      meta,
      coverImage,
      videoMapStartMs,
      durationMs,
      scrollMs,
      async (rgbaData: Buffer) => {
        const ok = videoStream.write(rgbaData);
        if (!ok) {
          await new Promise<void>((res) => videoStream.once('drain', res));
        }
      },
      renderOpts,
    )
      .then(() => videoStream.end())
      .catch((err: unknown) => {
        videoStream.destroy(
          err instanceof Error ? err : new Error(String(err)),
        );
        reject(err);
      });
  });
}

/**
 * Fetches the beatmap cover image from the osu! CDN.
 * Returns null if unavailable.
 */
export async function fetchCoverImage(
  beatmapSetId: string,
): Promise<Buffer | null> {
  const url = `https://assets.ppy.sh/beatmaps/${beatmapSetId}/covers/cover@2x.jpg`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, config.render.coverFetchTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cleans up the temporary video file after it has been sent.
 */
export async function cleanupVideo(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
