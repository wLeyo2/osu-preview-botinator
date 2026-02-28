import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import logger from '@/utils/logger';
import type { AudioResult } from './fetchAudio';
import type { BeatmapMeta } from './parseBeatmap';
import {
  DEFAULT_SCROLL_MS,
  FPS,
  renderFrames,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from './renderer';

/** Hard cap on rendered video length. Maps longer than this show only the last 4 minutes. */
const MAX_RENDER_MS = 240_000; // 4 minutes

/**
 * Encodes a mania preview video and returns the path to the temporary file.
 *
 * The video always starts 1 second before the first hit object (map start),
 * NOT at the audio preview time — the audio still seeks to the preview time
 * so the song plays in sync.
 *
 * @param meta       Parsed beatmap metadata
 * @param audio      Audio data extracted from the .osz
 * @param coverImage Cover image buffer (optional)
 * @param audioStartMs  Where in the song the audio seek begins (preview time)
 * @param scrollMs   Visible note window in ms (controls scroll speed)
 * @returns          Absolute path to the output .mp4 file
 */
export async function encodeVideo(
  meta: BeatmapMeta,
  audio: AudioResult,
  coverImage: Buffer | null,
  audioStartMs: number,
  scrollMs = DEFAULT_SCROLL_MS,
): Promise<string> {
  const firstNoteMs = meta.notes[0]?.startTime ?? 0;
  const lastNoteMs =
    meta.notes.at(-1)?.endTime ?? meta.notes.at(-1)?.startTime ?? firstNoteMs;
  const drainMs =
    meta.drainSeconds > 0 ? meta.drainSeconds * 1000 : MAX_RENDER_MS;

  let videoMapStartMs: number;
  let durationMs: number;

  if (drainMs <= MAX_RENDER_MS) {
    // Short map: start 1 s before first note, render the whole thing
    videoMapStartMs = Math.max(0, firstNoteMs - 1000);
    durationMs = drainMs;
  } else {
    // Long map: render only the last 4 minutes
    videoMapStartMs = Math.max(0, lastNoteMs - MAX_RENDER_MS);
    durationMs = MAX_RENDER_MS;
  }

  const audioSeekMs = videoMapStartMs;

  const outPath = join(tmpdir(), `osu-preview-${randomUUID()}.mp4`);
  const audioPath = join(tmpdir(), `osu-audio-${randomUUID()}${audio.ext}`);

  await fs.writeFile(audioPath, audio.buffer);

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
          // Renderer is ahead of ffmpeg — wait for the buffer to drain
          await new Promise<void>((res) => videoStream.once('drain', res));
        }
      },
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
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Cleans up the temporary video file after it has been sent.
 */
export async function cleanupVideo(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
