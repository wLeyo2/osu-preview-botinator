import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { UnrecoverableError, Worker } from 'bullmq';
import { bullConnection, preflightRedisConnection } from '@/queue/connection';
import { closeStoreConnection, setCachedRenderResult } from '@/queue/store';
import type { RenderJobData, RenderResult } from '@/queue/types';
import { uploadVideoToR2 } from '@/r2';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { SUPPORTED_MODES } from '@/utils/osu/constants';
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
} from '@/utils/osu/fetchBeatmap';
import { type BeatmapMeta, parseBeatmap } from '@/utils/osu/parseBeatmap';

const WORKER_RECYCLE_EXIT_CODE = 75;

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

let jobsProcessed = 0;
let shuttingDown = false;

const beatmapMetaCache = new Map<string, BeatmapMeta>();
const redisErrorTimestamps: number[] = [];

try {
  await preflightRedisConnection('redis-worker-preflight');
} catch (error) {
  logger.error(
    `[Worker] Redis preflight failed: ${error instanceof Error ? error.message : String(error)}`,
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

function formatMemory(snapshot: MemorySnapshot): string {
  return `rss=${snapshot.rssMb}MB heap=${snapshot.heapUsedMb}/${snapshot.heapTotalMb}MB ext=${snapshot.externalMb}MB ab=${snapshot.arrayBuffersMb}MB`;
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

  while (redisErrorTimestamps.length > 0) {
    const oldest = redisErrorTimestamps[0];
    if (oldest && now - oldest > windowMs) {
      redisErrorTimestamps.shift();
      continue;
    }
    break;
  }

  redisErrorTimestamps.push(now);
  return redisErrorTimestamps.length >= config.render.workerRedisErrorBudget;
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
      coverFetch: 0,
      encodeVideo: 0,
      upload: 0,
      cacheWrite: 0,
    };

    let videoPath: string | null = null;
    const jobStartMs = performance.now();
    const memoryStart = memorySnapshot();
    loopDelay.reset();

    logger.info(
      `[Worker] start key=${renderKey} beatmap=${beatmapId} attempt=${job.attemptsMade + 1} ${formatMemory(memoryStart)}`,
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

      if (!SUPPORTED_MODES.includes(meta.mode)) {
        throw new UnrecoverableError(
          'This beatmap mode is not supported. Only osu!standard and osu!mania are supported.',
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

      const audioTask = (async () => {
        const startedAt = performance.now();
        const audio = await fetchAudioFromOsz(beatmapSetId, audioFilename);
        stageMs.audioFetch = Number((performance.now() - startedAt).toFixed(2));
        return audio;
      })();
      const coverTask = (async () => {
        const startedAt = performance.now();
        const cover = await fetchCoverImage(beatmapSetId);
        stageMs.coverFetch = Number((performance.now() - startedAt).toFixed(2));
        return cover;
      })();

      const [audio, coverImage] = await Promise.all([audioTask, coverTask]);

      const encodeStart = performance.now();
      videoPath = await encodeVideo(
        meta,
        audio,
        coverImage,
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
        videoUrl,
        createdAt: Date.now(),
      };

      const cacheStart = performance.now();
      await setCachedRenderResult(renderKey, result);
      stageMs.cacheWrite = Number((performance.now() - cacheStart).toFixed(2));

      const totalMs = Number((performance.now() - jobStartMs).toFixed(2));
      const memoryEnd = memorySnapshot();
      const lagP95Ms = Number((loopDelay.percentile(95) / 1e6).toFixed(2));
      const lagMaxMs = Number((loopDelay.max / 1e6).toFixed(2));

      logger.info(
        `[Worker] completed key=${renderKey} beatmap=${beatmapId} total=${totalMs}ms ` +
          `stages(fetch=${stageMs.fetchBeatmap}ms parse=${stageMs.parseBeatmap}ms audio=${stageMs.audioFetch}ms cover=${stageMs.coverFetch}ms encode=${stageMs.encodeVideo}ms upload=${stageMs.upload}ms cache=${stageMs.cacheWrite}ms) ` +
          `eventLoop(p95=${lagP95Ms}ms max=${lagMaxMs}ms) ` +
          `${formatMemory(memoryEnd)}`,
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

      logger.info(
        `[Worker metrics] key=${renderKey} processed=${jobsProcessed} total=${totalMs}ms ` +
          `memory(start=${formatMemory(memoryStart)} preGC=${formatMemory(memoryBeforeGc)} postGC=${formatMemory(memoryAfterGc)}) ` +
          `gc(ran=${gcResult.ran} mode=${gcResult.mode} reason=${gcResult.reason} duration=${gcResult.durationMs}ms)`,
      );

      const recycleReason = shouldRecycleWorker(memoryAfterGc);
      if (recycleReason && !shuttingDown) {
        logger.warn(`[Worker] recycle requested: ${recycleReason}`);
        void shutdown(WORKER_RECYCLE_EXIT_CODE);
      }
    }
  },
  {
    connection: bullConnection,
    concurrency: config.queue.workerConcurrency,
  },
);

worker.on('failed', (job, err) => {
  logger.error(
    `[Worker] failed key=${job?.data.renderKey ?? 'unknown'} reason=${err.message}`,
  );
});

worker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`);

  if (!isRedisConnectivityError(err.message)) return;

  if (!shouldStopOnRedisErrors()) {
    logger.warn(
      `[Worker] Redis error budget used ${redisErrorTimestamps.length}/${config.render.workerRedisErrorBudget}; waiting for recovery...`,
    );
    return;
  }

  logger.error(
    '[Worker] Redis error budget exhausted. Exiting worker process.',
  );
  void shutdown(1);
});

logger.info(
  `[Worker] listening queue=${config.queue.name} concurrency=${config.queue.workerConcurrency}`,
);

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('[Worker] shutting down gracefully...');
  await Promise.allSettled([worker.close(), closeStoreConnection()]);
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});
