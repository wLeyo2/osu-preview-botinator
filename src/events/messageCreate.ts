import { Events, type Message } from 'discord.js';
import { buildRenderKey } from '@/queue/renderKey';
import {
  acquireDeliveryWindow,
  acquireQueueNoticeWindow,
  addChannelSubscription,
  getCachedRenderResult,
  getQueueStatusMessageId,
  removeChannelSubscription,
  setQueueStatusMessageId,
} from '@/queue/store';
import type { RenderJobData } from '@/queue/types';
import {
  enqueueRenderJob,
  estimateQueueWaitSeconds,
  getQueueBacklog,
  getRenderJobState,
} from '@/queue/videoQueue';
import config from '@/utils/config';
import { Cooldown } from '@/utils/cooldown';
import logger from '@/utils/logger';
import { BEATMAP_URL_REGEX } from '@/utils/osu/constants';
import { parseOsuUrl } from '@/utils/osu/fetchBeatmap';
import { getScrollMs } from '@/utils/osu/scrollSpeed';
import { getUserPrefs } from '@/utils/osu/userPrefs';
import type { Event } from '@/utils/types/event';

const requestCooldown = new Cooldown(config.queue.requestCooldownSec);
const allowedGuildIds = new Set(
  config.guildId
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

function isAllowedGuild(guildId: string): boolean {
  if (allowedGuildIds.size === 0) return false;
  return allowedGuildIds.has(guildId);
}

async function upsertQueueStatusMessage(
  message: Message,
  renderKey: string,
  content: string,
): Promise<void> {
  if (!message.guild) return;
  if (!message.channel.isTextBased() || !('messages' in message.channel))
    return;

  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const existingStatusMessageId = await getQueueStatusMessageId(
    renderKey,
    guildId,
    channelId,
  );

  if (existingStatusMessageId) {
    const existingMessage = await message.channel.messages
      .fetch(existingStatusMessageId)
      .catch(() => null);
    if (existingMessage) {
      const edited = await existingMessage.edit({ content }).catch(() => null);
      if (edited) return;
    }
  }

  const createdMessage = await message.reply({ content }).catch(() => null);
  if (!createdMessage) return;

  await setQueueStatusMessageId(
    renderKey,
    guildId,
    channelId,
    createdMessage.id,
  ).catch(() => {});
}

export const event: Event<Events.MessageCreate> = {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!isAllowedGuild(message.guild.id)) return;

    const match = message.content.match(BEATMAP_URL_REGEX);
    if (!match) return;

    if (
      config.queue.requestCooldownSec > 0 &&
      requestCooldown.check(message.author.id)
    ) {
      const remaining = requestCooldown.getRemainingTime(message.author.id);
      await message
        .reply({
          content: `Please wait ${remaining}s before requesting again.`,
        })
        .catch(() => {});
      return;
    }

    if (config.queue.requestCooldownSec > 0) {
      requestCooldown.set(message.author.id);
    }

    const sourceUrl = match[0];

    let beatmapSetId = '';
    let beatmapId = '';
    try {
      ({ beatmapSetId, beatmapId } = parseOsuUrl(sourceUrl));
    } catch (err) {
      await message
        .reply({
          content: err instanceof Error ? err.message : 'Invalid osu! URL.',
        })
        .catch(() => {});
      return;
    }

    const userPrefs = await getUserPrefs(message.author.id);
    const scrollMs = await getScrollMs(message.author.id);
    const renderOpts = {
      noteStyle: userPrefs.noteStyle,
      noteColors: userPrefs.noteColors,
      noteColorSpecial: userPrefs.noteColorSpecial,
      scrollDirection: userPrefs.scrollDirection,
      strainOverlay: userPrefs.strainOverlay,
    };

    const renderKey = buildRenderKey({
      beatmapId,
      scrollMs,
      renderMode: userPrefs.renderMode,
      renderOpts,
    });

    let subscribed = false;

    try {
      const cachedResult = await getCachedRenderResult(renderKey);
      if (cachedResult) {
        const canDeliver = await acquireDeliveryWindow(
          renderKey,
          message.guild.id,
          message.channel.id,
        );

        if (canDeliver) {
          await message
            .reply({ content: cachedResult.videoUrl })
            .catch(() => {});
          logger.info(
            `[Render cache hit] beatmap=${beatmapId} key=${renderKey} guild=${message.guild.id} channel=${message.channel.id}`,
          );
        } else {
          const shouldNotice = await acquireQueueNoticeWindow(
            renderKey,
            message.guild.id,
            message.channel.id,
          );
          if (shouldNotice) {
            await message
              .reply({
                content:
                  'That preview was already posted in this channel recently. Ask again in a few minutes to repost the cached URL.',
              })
              .catch(() => {});
          }
        }

        return;
      }

      const [jobState, backlogBefore] = await Promise.all([
        getRenderJobState(renderKey),
        getQueueBacklog(),
      ]);
      const hasInFlightJob =
        jobState === 'waiting' ||
        jobState === 'active' ||
        jobState === 'delayed';
      const queueSaturated =
        backlogBefore.totalPending >= config.queue.maxBacklog;

      if (queueSaturated && !hasInFlightJob) {
        const shouldNotice = await acquireQueueNoticeWindow(
          renderKey,
          message.guild.id,
          message.channel.id,
        );

        if (shouldNotice) {
          const etaSec = estimateQueueWaitSeconds(backlogBefore);
          const etaMinutes = Math.max(1, Math.ceil(etaSec / 60));
          await message
            .reply({
              content:
                `Render queue is currently full (${backlogBefore.totalPending}/${config.queue.maxBacklog}). ` +
                `Please retry in a few minutes (estimated wait ~${etaMinutes} min).`,
            })
            .catch(() => {});
        }

        logger.warn(
          `[Render rejected] beatmap=${beatmapId} key=${renderKey} backlog=${backlogBefore.totalPending} limit=${config.queue.maxBacklog}`,
        );
        return;
      }

      await addChannelSubscription(
        renderKey,
        message.guild.id,
        message.channel.id,
      );
      subscribed = true;

      const jobData: RenderJobData = {
        renderKey,
        sourceUrl,
        beatmapId,
        beatmapSetId: beatmapSetId || undefined,
        requesterId: message.author.id,
        scrollMs,
        renderMode: userPrefs.renderMode,
        renderOpts,
      };

      const { created } = hasInFlightJob
        ? { created: false }
        : await enqueueRenderJob(renderKey, jobData);

      const backlogAfter = await getQueueBacklog();
      const etaSec = estimateQueueWaitSeconds(backlogAfter);
      const etaMinutes = Math.max(1, Math.ceil(etaSec / 60));
      const queueDepth = `${backlogAfter.totalPending}/${config.queue.maxBacklog}`;

      const shouldNotice = await acquireQueueNoticeWindow(
        renderKey,
        message.guild.id,
        message.channel.id,
      );
      if (shouldNotice) {
        await upsertQueueStatusMessage(
          message,
          renderKey,
          created
            ? `Render queued (queue ${queueDepth}, ETA ~${etaMinutes} min).`
            : `This preview is already rendering (queue ${queueDepth}, ETA ~${etaMinutes} min).`,
        );
      }

      logger.info(
        `[Render enqueued] beatmap=${beatmapId} key=${renderKey} created=${created} guild=${message.guild.id} channel=${message.channel.id}`,
      );
    } catch (err) {
      logger.error(err);
      if (subscribed) {
        await removeChannelSubscription(
          renderKey,
          message.guild.id,
          message.channel.id,
        ).catch(() => {});
      }
      await message
        .reply({
          content:
            'Failed to queue preview render. Please try again in a moment.',
        })
        .catch(() => {});
    }
  },
};
