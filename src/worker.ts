import { UnrecoverableError, Worker } from 'bullmq';
import { bullConnection } from '@/queue/connection';
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
import { parseBeatmap } from '@/utils/osu/parseBeatmap';

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

    logger.info(
      `[Worker] start key=${renderKey} beatmap=${beatmapId} attempt=${job.attemptsMade + 1}`,
    );

    let videoPath: string | null = null;

    try {
      const rawBeatmap = await fetchBeatmap(beatmapId);
      const meta = parseBeatmap(rawBeatmap);

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

      const [audio, coverImage] = await Promise.all([
        fetchAudioFromOsz(beatmapSetId, audioFilename),
        fetchCoverImage(beatmapSetId),
      ]);

      videoPath = await encodeVideo(
        meta,
        audio,
        coverImage,
        previewTime,
        scrollMs,
        renderOpts,
        renderMode,
      );

      const fileName = `preview/${renderKey}.mp4`;
      const videoUrl = await uploadVideoToR2(videoPath, fileName);
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

      await setCachedRenderResult(renderKey, result);

      logger.info(
        `[Worker] completed key=${renderKey} beatmap=${beatmapId} url=${videoUrl}`,
      );

      return result;
    } finally {
      if (videoPath) {
        await cleanupVideo(videoPath).catch(() => {});
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

  if (
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|Connection is closed/i.test(err.message)
  ) {
    logger.error('[Worker] Redis is unavailable. Exiting worker process.');
    void shutdown(1);
  }
});

logger.info(
  `[Worker] listening queue=${config.queue.name} concurrency=${config.queue.workerConcurrency}`,
);

let shuttingDown = false;
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
