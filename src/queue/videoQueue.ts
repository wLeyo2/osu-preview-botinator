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

export interface QueueBacklog {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  paused: number;
  totalPending: number;
}

export async function getQueueBacklog(): Promise<QueueBacklog> {
  const counts = await videoQueue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'paused',
  );

  const waiting = counts.waiting ?? 0;
  const active = counts.active ?? 0;
  const delayed = counts.delayed ?? 0;
  const prioritized = counts.prioritized ?? 0;
  const paused = counts.paused ?? 0;

  return {
    waiting,
    active,
    delayed,
    prioritized,
    paused,
    totalPending: waiting + active + delayed + prioritized + paused,
  };
}

export function estimateQueueWaitSeconds(backlog: QueueBacklog): number {
  const effectiveWorkers = Math.max(1, config.queue.workerConcurrency);
  const queuedAhead = backlog.waiting + backlog.delayed + backlog.prioritized;
  const estimatedJobsAhead = queuedAhead + Math.max(0, backlog.active - 1);
  const estimatedSeconds =
    (estimatedJobsAhead * config.queue.estimatedJobSec) / effectiveWorkers;

  return Math.max(0, Math.round(estimatedSeconds));
}

export async function getRenderJobState(
  renderKey: string,
): Promise<
  'missing' | 'waiting' | 'active' | 'delayed' | 'completed' | 'failed'
> {
  const job = await videoQueue.getJob(renderKey);
  if (!job) return 'missing';

  const state = await job.getState();
  if (
    state === 'waiting' ||
    state === 'active' ||
    state === 'delayed' ||
    state === 'completed' ||
    state === 'failed'
  ) {
    return state;
  }

  return 'waiting';
}

queueEvents.on('error', (err: Error) => {
  logger.error(`QueueEvents error: ${err.message}`);
});
