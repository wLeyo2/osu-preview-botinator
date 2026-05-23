import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '@/utils/config';
import logger from '@/utils/logger';
import type { AudioResult } from './fetchAudio';
import type { BeatmapMeta } from './parseBeatmap';
import type { RenderOptions } from './renderer';
import { renderManiaFrames, VIDEO_HEIGHT, VIDEO_WIDTH } from './renderer';
import type { RenderMode } from './userPrefs';

// ─── Constants ───

const MAX_RENDER_MS = 240_000;
const TAIL_MS = 1000;

// ─── Codec detection ───

type Codec = 'libx264' | 'libx265' | 'libsvtav1';

interface CodecInfo {
  name: Codec;
  preset: string;
  extraArgs: string[];
}

function detectCodec(): CodecInfo {
  const codec = config.render.ffmpegCodec;
  if (codec === 'av1' || codec === 'libsvtav1') {
    return {
      name: 'libsvtav1',
      preset: '12',
      extraArgs: ['-svtav1-params', 'tune=0'],
    };
  }
  if (codec === 'h265' || codec === 'hevc' || codec === 'libx265') {
    return {
      name: 'libx265',
      preset: 'ultrafast',
      extraArgs: ['-tag:v', 'hvc1'],
    };
  }
  return { name: 'libx264', preset: 'ultrafast', extraArgs: [] };
}

// ─── FFmpeg args builder ───

function buildFfmpegArgs(
  codecInfo: CodecInfo,
  fps: number,
  audioPath: string,
  audioSeekMs: number,
  durationMs: number,
  outPath: string,
): string[] {
  const { ffmpegThreads, audioBitrateKbps } = config.render;

  return [
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
    '-ss',
    (audioSeekMs / 1000).toFixed(3),
    '-i',
    audioPath,
    '-c:v',
    codecInfo.name,
    '-preset',
    codecInfo.preset,
    '-tune',
    'zerolatency',
    '-threads',
    String(Math.min(ffmpegThreads, 2)),
    ...(codecInfo.name === 'libx264' || codecInfo.name === 'libx265'
      ? ['-crf', '28']
      : []),
    ...codecInfo.extraArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-t',
    (durationMs / 1000).toFixed(3),
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  ];
}

// ─── Main encode function ───

export async function encodeVideo(
  meta: BeatmapMeta,
  audio: AudioResult,
  _coverImage: Buffer | null,
  previewTime: number,
  scrollMs = 500,
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
    videoMapStartMs = Math.max(0, firstNoteMs - 1000);
    durationMs = drainMs + TAIL_MS;
  } else if (renderMode === 'preview') {
    const halfWindow = MAX_RENDER_MS / 2;
    const idealStart = previewTime - halfWindow;
    const clampedStart = Math.max(
      firstNoteMs,
      Math.min(idealStart, lastNoteMs - MAX_RENDER_MS),
    );
    videoMapStartMs = clampedStart;
    durationMs = MAX_RENDER_MS + TAIL_MS;
  } else {
    videoMapStartMs = Math.max(0, lastNoteMs - MAX_RENDER_MS);
    durationMs = MAX_RENDER_MS + TAIL_MS;
  }

  const audioSeekMs = videoMapStartMs;
  const outPath = join(tmpdir(), `osu-preview-${randomUUID()}.mp4`);
  const audioPath = join(tmpdir(), `osu-audio-${randomUUID()}${audio.ext}`);

  await fs.writeFile(audioPath, audio.buffer);
  (audio as { buffer: Buffer | null }).buffer = null;

  try {
    await runEncode(
      meta,
      videoMapStartMs,
      durationMs,
      audioSeekMs,
      audioPath,
      outPath,
      scrollMs,
      renderOpts,
    );
    logger.info(`Video encoded: ${outPath}`);
    return outPath;
  } catch (err) {
    await fs.unlink(outPath).catch(() => {});
    throw err;
  } finally {
    await fs.unlink(audioPath).catch(() => {});
  }
}

async function runEncode(
  meta: BeatmapMeta,
  videoMapStartMs: number,
  durationMs: number,
  audioSeekMs: number,
  audioPath: string,
  outPath: string,
  scrollMs: number,
  renderOpts: RenderOptions,
): Promise<void> {
  const fps = config.render.fps;
  const totalFrames = Math.ceil((durationMs / 1000) * fps);
  const _frameSize = VIDEO_WIDTH * VIDEO_HEIGHT * 4;

  const codecInfo = detectCodec();
  logger.info(
    `[Encoder] codec=${codecInfo.name} preset=${codecInfo.preset} frames=${totalFrames} @${fps}fps`,
  );

  const ffmpegArgs = buildFfmpegArgs(
    codecInfo,
    fps,
    audioPath,
    audioSeekMs,
    durationMs,
    outPath,
  );

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let ffmpegExited = false;
  let _ffmpegExitCode: number | null = null;
  let ffmpegCloseError: Error | null = null;

  ffmpegProc.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      if (
        line.includes('frame=') ||
        line.includes('error') ||
        line.includes('Error')
      ) {
        logger.debug(`[FFmpeg] ${line.trim()}`);
      }
    }
  });

  ffmpegProc.on('close', (code) => {
    ffmpegExited = true;
    _ffmpegExitCode = code;
    if (code !== 0) {
      ffmpegCloseError = new Error(`FFmpeg exited with code ${code}`);
      logger.error(`[FFmpeg] exited with code ${code}`);
    } else {
      logger.info('[FFmpeg] encoding complete');
    }
  });

  ffmpegProc.on('error', (err) => {
    logger.error(`[FFmpeg] process error: ${err.message}`);
  });

  const stdin = ffmpegProc.stdin;
  if (!stdin) throw new Error('FFmpeg stdin not available');
  // Returns a promise that resolves when the frame is consumed.
  const writeFrame = (buffer: Buffer): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (ffmpegExited) {
        reject(ffmpegCloseError ?? new Error('FFmpeg already exited'));
        return;
      }
      const ok = stdin.write(buffer);
      if (ok) {
        resolve();
      } else {
        stdin.once('drain', resolve);
      }
    });
  };

  // Run the renderer, piping each frame directly to FFmpeg.
  // The writeFrame backpressure naturally throttles the renderer.
  try {
    await renderManiaFrames(
      {
        meta,
        startMs: videoMapStartMs,
        durationMs,
        scrollMs,
        fps,
        opts: renderOpts,
      },
      async (rgbaData: Buffer, frameIdx: number, total: number) => {
        // rgbaData is a ring buffer slot from the renderer (already a pure-JS copy).
        // Write directly to FFmpeg stdin with backpressure.
        await writeFrame(rgbaData);

        if (frameIdx > 0 && frameIdx % 500 === 0) {
          logger.debug(`[Encoder] frame ${frameIdx}/${total}`);
        }
      },
    );
  } catch (err) {
    // Kill FFmpeg if the renderer fails
    ffmpegProc.kill('SIGKILL');
    throw err;
  }

  // Signal EOF to FFmpeg
  stdin.end();

  // Wait for FFmpeg to finish
  await new Promise<void>((resolve, reject) => {
    if (ffmpegExited) {
      ffmpegCloseError ? reject(ffmpegCloseError) : resolve();
      return;
    }
    ffmpegProc.once('close', (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

// ─── Cover image fetch ───

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

// ─── Cleanup ───

export async function cleanupVideo(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
