import type { Client } from 'discord.js';
import logger from '@/utils/logger';
import {
  acquireDeliveryWindow,
  clearChannelSubscriptions,
  clearQueueStatusMessageId,
  getCachedRenderResult,
  getChannelSubscriptions,
  getQueueStatusMessageId,
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

type SendableTextChannel = {
  send: (payload: { content: string }) => Promise<unknown>;
  messages: {
    fetch: (messageId: string) => Promise<{
      edit: (payload: { content: string }) => Promise<unknown>;
    }>;
  };
};

async function fetchSendableChannel(
  client: Client,
  channelId: string,
): Promise<SendableTextChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    return null;
  }

  return channel as SendableTextChannel;
}

async function sendToChannel(
  client: Client,
  channelId: string,
  content: string,
): Promise<void> {
  const channel = await fetchSendableChannel(client, channelId);
  if (!channel) return;
  await channel.send({ content }).catch(() => {});
}

async function editQueueStatusMessage(
  client: Client,
  renderKey: string,
  guildId: string,
  channelId: string,
  content: string,
): Promise<boolean> {
  const statusMessageId = await getQueueStatusMessageId(
    renderKey,
    guildId,
    channelId,
  );
  if (!statusMessageId) return false;

  const channel = await fetchSendableChannel(client, channelId);
  if (!channel) {
    await clearQueueStatusMessageId(renderKey, guildId, channelId).catch(
      () => {},
    );
    return false;
  }

  const statusMessage = await channel.messages
    .fetch(statusMessageId)
    .catch(() => null);
  if (!statusMessage) {
    await clearQueueStatusMessageId(renderKey, guildId, channelId).catch(
      () => {},
    );
    return false;
  }

  const edited = await statusMessage.edit({ content }).catch(() => null);
  if (!edited) {
    await clearQueueStatusMessageId(renderKey, guildId, channelId).catch(
      () => {},
    );
    return false;
  }

  return true;
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

      const label = result.beatmapTitle || `beatmap #${result.beatmapId}`;
      const content = `[${label}](${result.videoUrl})`;
      const edited = await editQueueStatusMessage(
        client,
        renderKey,
        sub.guildId,
        sub.channelId,
        content,
      );
      if (!edited) {
        await sendToChannel(client, sub.channelId, content);
      }

      await clearQueueStatusMessageId(
        renderKey,
        sub.guildId,
        sub.channelId,
      ).catch(() => {});
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
      const content = `Failed to render preview for <${source}>: ${shortReason}`;
      const edited = await editQueueStatusMessage(
        client,
        renderKey,
        sub.guildId,
        sub.channelId,
        content,
      );
      if (!edited) {
        await sendToChannel(client, sub.channelId, content);
      }

      await clearQueueStatusMessageId(
        renderKey,
        sub.guildId,
        sub.channelId,
      ).catch(() => {});
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
