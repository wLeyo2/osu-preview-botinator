import type { Client } from 'discord.js';
import logger from '@/utils/logger';
import {
  acquireDeliveryWindow,
  clearChannelSubscriptions,
  getCachedRenderResult,
  getChannelSubscriptions,
  setCachedRenderResult,
} from './store';
import type { RenderResult } from './types';
import { queueEvents, videoQueue } from './videoQueue';

let started = false;
let notifierClient: Client | null = null;
const MAX_NOTIFY_CONCURRENCY = 4;

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) return;
        const item = items[currentIndex];
        if (!item) continue;
        await worker(item);
      }
    },
  );

  await Promise.allSettled(workers);
}

async function sendToChannel(
  client: Client,
  channelId: string,
  content: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const sendable = channel as {
    send: (payload: { content: string }) => Promise<unknown>;
  };
  await sendable.send({ content }).catch(() => {});
}

async function notifyCompleted(renderKey: string): Promise<void> {
  if (!notifierClient) return;
  const client = notifierClient;

  const subscriptions = await getChannelSubscriptions(renderKey);
  if (subscriptions.length === 0) return;

  let result = await getCachedRenderResult(renderKey);
  if (!result) {
    const job = await videoQueue.getJob(renderKey);
    const returnValue = job?.returnvalue as RenderResult | undefined;
    if (returnValue?.videoUrl) {
      result = returnValue;
      await setCachedRenderResult(renderKey, returnValue);
    }
  }

  if (!result) {
    logger.error(
      `[Notifier] completed job without cached result key=${renderKey}`,
    );
    await clearChannelSubscriptions(renderKey);
    return;
  }

  await forEachWithConcurrency(
    subscriptions,
    MAX_NOTIFY_CONCURRENCY,
    async (sub) => {
      const canDeliver = await acquireDeliveryWindow(
        renderKey,
        sub.guildId,
        sub.channelId,
      );
      if (!canDeliver) return;

      const source =
        result.sourceUrl || `https://osu.ppy.sh/b/${result.beatmapId}`;
      await sendToChannel(
        client,
        sub.channelId,
        `Preview ready for <${source}>\n${result.videoUrl}`,
      );
    },
  );

  await clearChannelSubscriptions(renderKey);
}

async function notifyFailed(renderKey: string, reason: string): Promise<void> {
  if (!notifierClient) return;
  const client = notifierClient;

  const job = await videoQueue.getJob(renderKey);
  if (job) {
    const state = await job.getState();
    if (state !== 'failed') return;
  }

  const subscriptions = await getChannelSubscriptions(renderKey);
  if (subscriptions.length === 0) return;

  const source = job?.data.sourceUrl || 'that beatmap';
  const shortReason =
    reason.length > 180 ? `${reason.slice(0, 180)}...` : reason;

  await forEachWithConcurrency(
    subscriptions,
    MAX_NOTIFY_CONCURRENCY,
    async (sub) => {
      await sendToChannel(
        client,
        sub.channelId,
        `Failed to render preview for <${source}>: ${shortReason}`,
      );
    },
  );

  await clearChannelSubscriptions(renderKey);
}

const onCompleted = (payload: { jobId: string }) => {
  if (!payload.jobId) return;
  void notifyCompleted(payload.jobId);
};

const onFailed = (payload: { jobId?: string; failedReason: string }) => {
  if (!payload.jobId) return;
  void notifyFailed(payload.jobId, payload.failedReason || 'Unknown error');
};

export async function startQueueNotifier(client: Client): Promise<void> {
  if (started) return;

  notifierClient = client;
  await queueEvents.waitUntilReady();

  queueEvents.on('completed', onCompleted);
  queueEvents.on('failed', onFailed);

  started = true;
  logger.info('[Notifier] queue notifier started');
}

export function stopQueueNotifier(): void {
  if (!started) return;

  queueEvents.off('completed', onCompleted);
  queueEvents.off('failed', onFailed);

  started = false;
  notifierClient = null;
}
