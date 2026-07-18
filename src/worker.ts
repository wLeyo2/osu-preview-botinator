import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { UnrecoverableError, Worker } from 'bullmq';
import { bullConnection, preflightRedisConnection } from '@/queue/connection';
import { closeStoreConnection, setCachedRenderResult } from '@/queue/store';
import type { RenderJobData, RenderResult } from '@/queue/types';
import { pruneBucketLimit, uploadVideoToR2 } from '@/r2';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { SUPPORTED_MODES } from '@/utils/osu/constants';
import { cleanupVideo, encodeVideo } from '@/utils/osu/encoder';
import {
  extractAudioFilename,
  fetchAudioFromOsz,
} from '@/utils/osu/fetchAudio';
import {
  extractPreviewTime,
  extractSetId,
  fetchBeatmap,
} from '@/utils/osu/fetchBeatmap';
import { type BeatmapMeta, parseBeatmap } from '@/utils/osu/parseBeatmap';

const WORKER_RECYCLE_EXIT_CODE = 75;
const SIGTERM_EXIT_CODE = 143;

interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

interface GcResult {
  ran: boolean;
  durationMs: number;
  mode: 'off' | 'incremental' | 'aggressive';
  reason: 'interval' | 'rss-threshold' | 'disabled';
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const workerLogger = logger.child({ service: 'worker' });

let jobsProcessed = 0;
let shuttingDown = false;

const beatmapMetaCache = new Map<string, BeatmapMeta>();
const redisErrorTimestamps: number[] = [];
let redisErrorHead = 0;
const supportedModes = new Set(SUPPORTED_MODES);

try {
  await preflightRedisConnection('redis-worker-preflight');
} catch (error) {
  workerLogger.error(
    { reason: error instanceof Error ? error.message : String(error) },
    'Redis preflight failed',
  );
  process.exit(1);
}

function toMb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

function memorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
  };
}

function isLikelyPermanentError(message: string): boolean {
  if (
    message.includes('No specific difficulty selected') ||
    message.includes('Could not parse osu! URL') ||
    message.includes('Could not determine beatmap set ID') ||
    message.includes('No audio file found in the beatmapset archive') ||
    message.includes('not supported')
  ) {
    return true;
  }

  const httpMatch = message.match(/HTTP\s+(\d{3})/i);
  if (!httpMatch) return false;

  const status = Number(httpMatch[1]);
  if (Number.isNaN(status)) return false;
  if (status === 429) return false;

  return status >= 400 && status < 500;
}

function classifyJobError(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error;
  const baseError = error instanceof Error ? error : new Error(String(error));

  if (isLikelyPermanentError(baseError.message)) {
    return new UnrecoverableError(baseError.message);
  }

  return baseError;
}

function getParsedBeatmap(beatmapId: string, rawBeatmap: string): BeatmapMeta {
  if (config.render.workerBeatmapCacheSize <= 0) {
    return parseBeatmap(rawBeatmap);
  }

  const cached = beatmapMetaCache.get(beatmapId);
  if (cached) {
    beatmapMetaCache.delete(beatmapId);
    beatmapMetaCache.set(beatmapId, cached);
    logger.debug(`[Worker cache] hit beatmap=${beatmapId}`);
    return cached;
  }

  const parsed = parseBeatmap(rawBeatmap);
  beatmapMetaCache.set(beatmapId, parsed);

  if (beatmapMetaCache.size > config.render.workerBeatmapCacheSize) {
    const oldestKey = beatmapMetaCache.keys().next().value;
    if (oldestKey) {
      beatmapMetaCache.delete(oldestKey);
    }
  }

  return parsed;
}

function maybeRunManualGc(currentMemory: MemorySnapshot): GcResult {
  if (config.render.gcMode === 'off') {
    return {
      ran: false,
      durationMs: 0,
      mode: 'off',
      reason: 'disabled',
    };
  }

  if (typeof Bun === 'undefined' || typeof Bun.gc !== 'function') {
    return {
      ran: false,
      durationMs: 0,
      mode: config.render.gcMode,
      reason: 'disabled',
    };
  }

  const intervalHit = jobsProcessed % config.render.gcEveryNJobs === 0;
  const rssThresholdHit =
    config.render.gcRssThresholdMb > 0 &&
    currentMemory.rssMb >= config.render.gcRssThresholdMb;

  if (!intervalHit && !rssThresholdHit) {
    return {
      ran: false,
      durationMs: 0,
      mode: config.render.gcMode,
      reason: 'disabled',
    };
  }

  const forceAggressive =
    config.render.gcMode === 'aggressive' ||
    (rssThresholdHit && config.render.gcMode === 'incremental');

  const gcStart = performance.now();
  Bun.gc(forceAggressive);
  const gcDurationMs = performance.now() - gcStart;

  return {
    ran: true,
    durationMs: Number(gcDurationMs.toFixed(2)),
    mode: forceAggressive ? 'aggressive' : 'incremental',
    reason: rssThresholdHit ? 'rss-threshold' : 'interval',
  };
}

function shouldRecycleWorker(currentMemory: MemorySnapshot): string | null {
  if (
    config.render.workerMaxJobsBeforeRestart > 0 &&
    jobsProcessed >= config.render.workerMaxJobsBeforeRestart
  ) {
    return `processed ${jobsProcessed} jobs (limit=${config.render.workerMaxJobsBeforeRestart})`;
  }

  if (
    config.render.workerRestartRssMb > 0 &&
    currentMemory.rssMb >= config.render.workerRestartRssMb
  ) {
    return `rss=${currentMemory.rssMb}MB (limit=${config.render.workerRestartRssMb}MB)`;
  }

  return null;
}

function isRedisConnectivityError(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|Connection is closed|ETIMEDOUT/i.test(
    message,
  );
}

function shouldStopOnRedisErrors(): boolean {
  const now = Date.now();
  const windowMs = config.render.workerRedisErrorWindowMs;

  while (redisErrorHead < redisErrorTimestamps.length) {
    const oldest = redisErrorTimestamps[redisErrorHead];
    if (oldest && now - oldest > windowMs) {
      redisErrorHead += 1;
      continue;
    }
    break;
  }

  if (redisErrorHead > 0 && redisErrorHead * 2 >= redisErrorTimestamps.length) {
    redisErrorTimestamps.splice(0, redisErrorHead);
    redisErrorHead = 0;
  }

  redisErrorTimestamps.push(now);
  return (
    redisErrorTimestamps.length - redisErrorHead >=
    config.render.workerRedisErrorBudget
  );
}

const worker = new Worker<RenderJobData, RenderResult>(
  config.queue.name,
  async (job) => {
    const {
      renderKey,
      sourceUrl,
      beatmapId,
      beatmapSetId: beatmapSetIdHint,
      scrollMs,
      renderMode,
      renderOpts,
    } = job.data;

    const stageMs: Record<string, number> = {
      fetchBeatmap: 0,
      parseBeatmap: 0,
      audioFetch: 0,
      encodeVideo: 0,
      upload: 0,
      cacheWrite: 0,
    };

    let videoPath: string | null = null;
    const jobStartMs = performance.now();
    const memoryStart = memorySnapshot();
    loopDelay.reset();

    workerLogger.info(
      {
        renderKey,
        beatmapId,
        attempt: job.attemptsMade + 1,
        memory: memoryStart,
      },
      'Job started',
    );

    try {
      const fetchStart = performance.now();
      const rawBeatmap = await fetchBeatmap(beatmapId);
      stageMs.fetchBeatmap = Number(
        (performance.now() - fetchStart).toFixed(2),
      );

      const parseStart = performance.now();
      const meta = getParsedBeatmap(beatmapId, rawBeatmap);
      stageMs.parseBeatmap = Number(
        (performance.now() - parseStart).toFixed(2),
      );

      if (!supportedModes.has(meta.mode)) {
        throw new UnrecoverableError(
          'This beatmap mode is not supported. Only osu!standard, osu!taiko and osu!mania are supported.',
        );
      }

      const beatmapSetId = beatmapSetIdHint || extractSetId(rawBeatmap);
      if (!beatmapSetId) {
        throw new UnrecoverableError(
          'Could not determine beatmap set ID from URL or .osu file.',
        );
      }

      const previewTime = extractPreviewTime(rawBeatmap);
      const audioFilename = extractAudioFilename(rawBeatmap);

      // Audio download runs concurrently with the render inside encodeVideo;
      // the encoder awaits it only when it's time to mux.
      const audioTask = (async () => {
        const startedAt = performance.now();
        const audio = await fetchAudioFromOsz(beatmapSetId, audioFilename);
        stageMs.audioFetch = Number((performance.now() - startedAt).toFixed(2));
        return audio;
      })();

      const encodeStart = performance.now();
      videoPath = await encodeVideo(
        meta,
        audioTask,
        previewTime,
        scrollMs,
        renderOpts,
        renderMode,
      );
      stageMs.encodeVideo = Number(
        (performance.now() - encodeStart).toFixed(2),
      );

      const uploadStart = performance.now();
      const fileName = `preview/${renderKey}.mp4`;
      const videoUrl = await uploadVideoToR2(videoPath, fileName);
      stageMs.upload = Number((performance.now() - uploadStart).toFixed(2));

      if (!videoUrl) {
        throw new Error('Upload to R2 failed.');
      }

      const result: RenderResult = {
        renderKey,
        sourceUrl,
        beatmapId,
        beatmapSetId,
        beatmapTitle: `${meta.artist} - ${meta.title} [${meta.version}]`,
        videoUrl,
        createdAt: Date.now(),
      };

      const cacheStart = performance.now();
      await setCachedRenderResult(renderKey, result);
      stageMs.cacheWrite = Number((performance.now() - cacheStart).toFixed(2));

      // Asynchronously prune R2 bucket to enforce capacity limits
      Promise.resolve()
        .then(() => pruneBucketLimit())
        .catch((err) => {
          workerLogger.error(
            { reason: err instanceof Error ? err.message : String(err) },
            'Unhandled error during pruneBucketLimit',
          );
        });

      const totalMs = Number((performance.now() - jobStartMs).toFixed(2));
      const memoryEnd = memorySnapshot();
      const lagP95Ms = Number((loopDelay.percentile(95) / 1e6).toFixed(2));
      const lagMaxMs = Number((loopDelay.max / 1e6).toFixed(2));

      workerLogger.info(
        {
          renderKey,
          beatmapId,
          totalMs,
          encodeMs: stageMs.encodeVideo,
          uploadMs: stageMs.upload,
          eventLoopP95Ms: lagP95Ms,
          eventLoopMaxMs: lagMaxMs,
          memory: memoryEnd,
        },
        'Job completed',
      );

      workerLogger.debug(
        {
          renderKey,
          beatmapId,
          stages: stageMs,
        },
        'Job stage timing breakdown',
      );

      return result;
    } catch (error) {
      throw classifyJobError(error);
    } finally {
      if (videoPath) {
        await cleanupVideo(videoPath).catch(() => {});
      }

      jobsProcessed += 1;

      const memoryBeforeGc = memorySnapshot();
      const gcResult = maybeRunManualGc(memoryBeforeGc);
      const memoryAfterGc = memorySnapshot();
      const totalMs = Number((performance.now() - jobStartMs).toFixed(2));

      workerLogger.debug(
        {
          renderKey,
          jobsProcessed,
          totalMs,
          memory: {
            start: memoryStart,
            preGc: memoryBeforeGc,
            postGc: memoryAfterGc,
          },
          gc: gcResult,
        },
        'Post-job metrics',
      );

      const recycleReason = shouldRecycleWorker(memoryAfterGc);
      if (recycleReason && !shuttingDown) {
        workerLogger.warn({ reason: recycleReason }, 'Recycle requested');
        void shutdown(WORKER_RECYCLE_EXIT_CODE, 'recycle');
      }
    }
  },
  {
    connection: bullConnection,
    concurrency: config.queue.workerConcurrency,
  },
);

worker.on('failed', (job, err) => {
  workerLogger.error(
    {
      renderKey: job?.data.renderKey ?? 'unknown',
      reason: err.message,
    },
    'Job failed',
  );
});

worker.on('error', (err) => {
  workerLogger.error({ reason: err.message }, 'Worker runtime error');

  if (!isRedisConnectivityError(err.message)) return;

  if (!shouldStopOnRedisErrors()) {
    workerLogger.warn(
      {
        used: redisErrorTimestamps.length - redisErrorHead,
        budget: config.render.workerRedisErrorBudget,
      },
      'Redis error budget usage increasing',
    );
    return;
  }

  workerLogger.error('Redis error budget exhausted. Exiting worker process.');
  void shutdown(1, 'redis-error-budget');
});

workerLogger.info(
  {
    queue: config.queue.name,
    concurrency: config.queue.workerConcurrency,
  },
  'Worker listening',
);

async function shutdown(exitCode: number, reason = 'manual'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  workerLogger.info({ reason }, 'Shutting down gracefully');
  await Promise.allSettled([worker.close(), closeStoreConnection()]);
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown(0, 'sigint');
});

process.on('SIGTERM', () => {
  void shutdown(SIGTERM_EXIT_CODE, 'sigterm');
});
