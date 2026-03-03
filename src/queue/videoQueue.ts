import { Queue, QueueEvents } from 'bullmq';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { bullConnection } from './connection';
import type { RenderJobData, RenderResult } from './types';

export const RENDER_JOB_NAME = 'render-preview';

export const videoQueue = new Queue<RenderJobData, RenderResult>(
  config.queue.name,
  {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: config.queue.jobAttempts,
      backoff: {
        type: 'exponential',
        delay: config.queue.jobBackoffMs,
      },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  },
);

export const queueEvents = new QueueEvents(config.queue.name, {
  connection: bullConnection,
});

function isDuplicateJobError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /job.?id|already exists|duplicated/i.test(err.message);
}

export async function enqueueRenderJob(
  renderKey: string,
  data: RenderJobData,
): Promise<{ created: boolean }> {
  const existing = await videoQueue.getJob(renderKey);
  if (existing) return { created: false };

  try {
    await videoQueue.add(RENDER_JOB_NAME, data, {
      jobId: renderKey,
    });
    return { created: true };
  } catch (err) {
    if (isDuplicateJobError(err)) {
      const job = await videoQueue.getJob(renderKey);
      if (job) return { created: false };
    }
    throw err;
  }
}

export async function closeQueueClients(): Promise<void> {
  await Promise.allSettled([queueEvents.close(), videoQueue.close()]);
}

queueEvents.on('error', (err: Error) => {
  logger.error(`QueueEvents error: ${err.message}`);
});
