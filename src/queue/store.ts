import type IORedis from 'ioredis';
import config from '@/utils/config';
import logger from '@/utils/logger';
import { createRedisConnection } from './connection';
import type { ChannelSubscription, RenderResult } from './types';
import type { UserPrefs } from '@/utils/osu/userPrefs';

let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    redis = createRedisConnection('redis-store');
  }

  return redis;
}

function key(...parts: string[]): string {
  return [config.redis.keyPrefix, ...parts].join(':');
}

function cachedResultKey(renderKey: string): string {
  return key('render', 'result', renderKey);
}

function subscriptionsKey(renderKey: string): string {
  return key('render', 'subs', renderKey);
}

function deliveryKey(
  renderKey: string,
  guildId: string,
  channelId: string,
): string {
  return key('render', 'delivery', guildId, channelId, renderKey);
}

function queueNoticeKey(
  renderKey: string,
  guildId: string,
  channelId: string,
): string {
  return key('render', 'queue-notice', guildId, channelId, renderKey);
}

function userPrefsKey(userId: string): string {
  return key('user', 'prefs', userId);
}

function encodeSub(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function decodeSub(token: string): ChannelSubscription | null {
  const [guildId, channelId] = token.split(':');
  if (!guildId || !channelId) return null;
  return { guildId, channelId };
}

export async function getCachedRenderResult(
  renderKey: string,
): Promise<RenderResult | null> {
  const raw = await getRedis().get(cachedResultKey(renderKey));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as RenderResult;
  } catch (err) {
    logger.warn(
      `Invalid cached render payload for ${renderKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    await getRedis().del(cachedResultKey(renderKey));
    return null;
  }
}

export async function setCachedRenderResult(
  renderKey: string,
  result: RenderResult,
): Promise<void> {
  await getRedis().set(
    cachedResultKey(renderKey),
    JSON.stringify(result),
    'EX',
    config.render.cacheTtlSec,
  );
}

export async function addChannelSubscription(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<void> {
  const token = encodeSub(guildId, channelId);
  const subKey = subscriptionsKey(renderKey);
  const client = getRedis();
  await client.sadd(subKey, token);
  await client.expire(subKey, Math.max(config.render.cacheTtlSec, 3_600));
}

export async function removeChannelSubscription(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<void> {
  await getRedis().srem(
    subscriptionsKey(renderKey),
    encodeSub(guildId, channelId),
  );
}

export async function getChannelSubscriptions(
  renderKey: string,
): Promise<ChannelSubscription[]> {
  const tokens = await getRedis().smembers(subscriptionsKey(renderKey));
  const parsed = tokens
    .map((token) => decodeSub(token))
    .filter((sub): sub is ChannelSubscription => sub !== null);

  if (parsed.length !== tokens.length) {
    logger.warn(`Invalid subscription tokens for ${renderKey}`);
  }

  return parsed;
}

export async function clearChannelSubscriptions(
  renderKey: string,
): Promise<void> {
  await getRedis().del(subscriptionsKey(renderKey));
}

export async function acquireDeliveryWindow(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const result = await getRedis().set(
    deliveryKey(renderKey, guildId, channelId),
    '1',
    'EX',
    config.render.deliveryDedupWindowSec,
    'NX',
  );
  return result === 'OK';
}

export async function acquireQueueNoticeWindow(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const result = await getRedis().set(
    queueNoticeKey(renderKey, guildId, channelId),
    '1',
    'EX',
    config.queue.queueNoticeCooldownSec,
    'NX',
  );
  return result === 'OK';
}

export async function closeStoreConnection(): Promise<void> {
  if (!redis) return;

  const client = redis;
  redis = null;

  await client.quit().catch(() => {
    client.disconnect();
  });
}
