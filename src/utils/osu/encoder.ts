import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import config from '@/utils/config';
import logger from '@/utils/logger';
import type { AudioResult } from './fetchAudio';
import type { BeatmapMeta } from './parseBeatmap';
import type { RenderOptions } from './renderer';
import { getRenderer } from './renderer';
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
      extraArgs: ['-crf', '28', '-tag:v', 'hvc1'],
    };
  }
  return { name: 'libx264', preset: 'ultrafast', extraArgs: ['-crf', '28'] };
}

// ─── FFmpeg args builders ───

interface VideoFfmpegOpts {
  codec: CodecInfo;
  fps: number;
  durationMs: number;
  outPath: string;
  width: number;
  height: number;
}

function buildVideoFfmpegArgs(opts: VideoFfmpegOpts): string[] {
  const { codec, fps, durationMs, outPath, width, height } = opts;

  return [
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
    '-c:v',
    codec.name,
    '-preset',
    codec.preset,
    ...codec.extraArgs,
    '-threads',
    String(config.render.ffmpegThreads),
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-t',
    (durationMs / 1000).toFixed(3),
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  ];
}

interface MuxFfmpegOpts {
  videoPath: string;
  audioPath: string;
  audioSeekMs: number;
  durationMs: number;
  outPath: string;
}

function buildMuxFfmpegArgs(opts: MuxFfmpegOpts): string[] {
  const { videoPath, audioPath, audioSeekMs, durationMs, outPath } = opts;

  return [
    '-i',
    videoPath,
    '-ss',
    (audioSeekMs / 1000).toFixed(3),
    '-i',
    audioPath,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    `${config.render.audioBitrateKbps}k`,
    '-t',
    (durationMs / 1000).toFixed(3),
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  ];
}

// ─── Main encode function ───

/**
 * Renders the beatmap to a video-only stream while the audio download
 * (audioTask) runs concurrently, then remuxes the audio on top.
 * Returns the path of the final video file.
 */
export async function encodeVideo(
  meta: BeatmapMeta,
  audioTask: Promise<AudioResult>,
  previewTime: number,
  scrollMs = 500,
  renderOpts: RenderOptions = {},
  renderMode: RenderMode = 'last4min',
): Promise<string> {
  const firstNoteMs = meta.firstObjectMs;
  const lastNoteMs = Math.max(meta.lastObjectMs, firstNoteMs);
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

  const renderer = getRenderer(meta.mode);
  // The taiko lane is horizontal and needs a longer lookahead than the
  // mania playfield; scale the user's scroll preference accordingly.
  const effectiveScrollMs = meta.mode === 1 ? scrollMs * 2 : scrollMs;

  // If one branch fails, stop the other instead of letting it run on.
  const cancel = new AbortController();
  const guard = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((err) => {
      if (!cancel.signal.aborted) cancel.abort(err);
      throw err;
    });

  let audioPath: string | null = null;
  let videoOnlyPath: string | null = null;

  const audioPromise = guard(
    audioTask.then(async (audio) => {
      const path = join(tmpdir(), `osu-audio-${randomUUID()}${audio.ext}`);
      await fs.writeFile(path, audio.buffer);
      (audio as { buffer: Buffer | null }).buffer = null;
      audioPath = path;
      return path;
    }),
  );

  const videoPromise = guard(
    encodeVideoOnly(
      renderer,
      meta,
      videoMapStartMs,
      durationMs,
      effectiveScrollMs,
      renderOpts,
      cancel.signal,
    ).then((path) => {
      videoOnlyPath = path;
      return path;
    }),
  );

  try {
    const [videoPath, resolvedAudioPath] = await settleBoth(
      videoPromise,
      audioPromise,
      cancel.signal,
    );

    const outPath = await muxAudio(
      videoPath,
      resolvedAudioPath,
      videoMapStartMs,
      durationMs,
    );
    logger.info(`Video encoded: ${outPath}`);
    return outPath;
  } finally {
    if (videoOnlyPath) await fs.unlink(videoOnlyPath).catch(() => {});
    if (audioPath) await fs.unlink(audioPath).catch(() => {});
  }
}

async function settleBoth<T, U>(
  first: Promise<T>,
  second: Promise<U>,
  cancelSignal: AbortSignal,
): Promise<[T, U]> {
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  if (firstResult.status === 'fulfilled' && secondResult.status === 'fulfilled')
    return [firstResult.value, secondResult.value];
  // The abort reason is the branch that failed first; the other branch's
  // rejection is just the cancellation cascade.
  if (cancelSignal.aborted && cancelSignal.reason instanceof Error)
    throw cancelSignal.reason;
  if (firstResult.status === 'rejected') throw firstResult.reason;
  throw (secondResult as PromiseRejectedResult).reason;
}

// ─── Video-only encode ───

async function encodeVideoOnly(
  renderer: ReturnType<typeof getRenderer>,
  meta: BeatmapMeta,
  startMs: number,
  durationMs: number,
  scrollMs: number,
  renderOpts: RenderOptions,
  signal: AbortSignal,
): Promise<string> {
  const fps = config.render.fps;
  const totalFrames = Math.ceil((durationMs / 1000) * fps);
  const outPath = join(tmpdir(), `osu-preview-video-${randomUUID()}.mp4`);
  const frameBytes = renderer.width * renderer.height * 4;
  const maxBufferedBytes = frameBytes * config.render.encoderBufferFrames;

  // canvas.data() returns a VIEW over the live canvas surface, and stream
  // writes keep queued buffers by reference — later renders would overwrite
  // frames still waiting in the queue (torn/duplicated frames). Copy each
  // frame into a ring slot before queueing; the ring outlives the deepest
  // possible queue (budget + in-flight write).
  const ringSize = config.render.encoderBufferFrames + 2;
  const frameRing: Buffer[] = Array.from({ length: ringSize }, () =>
    Buffer.allocUnsafe(frameBytes),
  );
  let ringIdx = 0;

  const codecInfo = detectCodec();
  logger.info(
    `[Encoder] codec=${codecInfo.name} preset=${codecInfo.preset} frames=${totalFrames} @${fps}fps ${renderer.width}x${renderer.height}`,
  );

  const ffmpegProc = spawn(
    'ffmpeg',
    buildVideoFfmpegArgs({
      codec: codecInfo,
      fps,
      durationMs,
      outPath,
      width: renderer.width,
      height: renderer.height,
    }),
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  logFfmpegStderr(ffmpegProc, 'Encode');

  let ffmpegFailure: Error | null = null;
  let stdinError: Error | null = null;
  const ffmpegDone = waitForFfmpeg(ffmpegProc, 'encoding').catch((err) => {
    ffmpegFailure = err instanceof Error ? err : new Error(String(err));
    throw ffmpegFailure;
  });
  void ffmpegDone.catch(() => {});

  const stdin = ffmpegProc.stdin;
  if (!stdin) throw new Error('FFmpeg stdin not available');
  stdin.on('error', (err) => {
    stdinError = err;
    logger.error(`[FFmpeg] stdin error: ${err.message}`);
  });

  try {
    await renderer.renderFrames(
      {
        meta,
        startMs,
        durationMs,
        scrollMs,
        fps,
        opts: renderOpts,
      },
      async (rgbaData: Buffer, frameIdx: number, total: number) => {
        if (signal.aborted) throw new Error('Encoding cancelled');
        const failure = ffmpegFailure ?? stdinError;
        if (failure) throw failure;
        const slot = frameRing[ringIdx % ringSize] as Buffer;
        ringIdx++;
        rgbaData.copy(slot, 0, 0, frameBytes);
        await writeFrame(
          stdin,
          slot,
          maxBufferedBytes,
          () => ffmpegFailure ?? stdinError,
        );

        if (frameIdx > 0 && frameIdx % 500 === 0) {
          logger.debug(`[Encoder] frame ${frameIdx}/${total}`);
        }
      },
    );
  } catch (err) {
    stdin.destroy();
    ffmpegProc.kill();
    await ffmpegDone.catch(() => {});
    await fs.unlink(outPath).catch(() => {});
    throw err;
  }

  if (!stdin.destroyed) stdin.end();
  await ffmpegDone;

  return outPath;
}

async function writeFrame(
  stdin: Writable,
  buffer: Buffer,
  maxBufferedBytes: number,
  getFailure: () => Error | null,
): Promise<void> {
  const beforeWriteFailure = getFailure();
  if (beforeWriteFailure) throw beforeWriteFailure;

  let canContinue: boolean;
  try {
    canContinue = stdin.write(buffer);
  } catch (err) {
    const failure = getFailure();
    throw failure ?? err;
  }
  // Each frame exceeds the pipe's highWaterMark, so write() returns false on
  // every call. Waiting for drain per frame would leave only one frame in
  // flight; instead keep queueing until the byte budget is hit, then let
  // ffmpeg catch up. 'drain' only fires after a false write, so never wait
  // when canContinue is true.
  if (canContinue || stdin.writableLength < maxBufferedBytes) {
    // This path awaits nothing real; when the renderer is the slower side it
    // would run as one unbroken microtask chain and starve timers and I/O
    // (audio download, BullMQ lock renewal). Yield to the event loop.
    await yieldToEventLoop();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stdin.off('drain', onDrain);
      stdin.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(getFailure() ?? err);
    };
    stdin.once('drain', onDrain);
    stdin.once('error', onError);
  });

  const afterDrainFailure = getFailure();
  if (afterDrainFailure) throw afterDrainFailure;
}

// ─── Audio remux ───

async function muxAudio(
  videoPath: string,
  audioPath: string,
  audioSeekMs: number,
  durationMs: number,
): Promise<string> {
  const outPath = join(tmpdir(), `osu-preview-${randomUUID()}.mp4`);
  const ffmpegProc = spawn(
    'ffmpeg',
    buildMuxFfmpegArgs({
      videoPath,
      audioPath,
      audioSeekMs,
      durationMs,
      outPath,
    }),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  logFfmpegStderr(ffmpegProc, 'Mux');
  try {
    await waitForFfmpeg(ffmpegProc, 'muxing');
  } catch (err) {
    await fs.unlink(outPath).catch(() => {});
    throw err;
  }
  return outPath;
}

// ─── FFmpeg process helpers ───

function logFfmpegStderr(proc: ReturnType<typeof spawn>, label: string): void {
  proc.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      if (
        line.includes('frame=') ||
        line.includes('error') ||
        line.includes('Error')
      ) {
        logger.debug(`[FFmpeg:${label}] ${line.trim()}`);
      }
    }
  });
}

function waitForFfmpeg(
  proc: ReturnType<typeof spawn>,
  action: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    proc.once('close', (code, signal) => {
      if (code === 0) {
        logger.info(`[FFmpeg] ${action} complete`);
        settle();
        return;
      }

      const status = code === null ? `signal ${signal}` : `code ${code}`;
      const error = new Error(`FFmpeg exited with ${status}`);
      logger.error(`[FFmpeg] ${action} failed: ${status}`);
      settle(error);
    });

    proc.once('error', (err) => {
      logger.error(`[FFmpeg] process error: ${err.message}`);
      settle(err);
    });
  });
}

// ─── Cleanup ───

export async function cleanupVideo(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
