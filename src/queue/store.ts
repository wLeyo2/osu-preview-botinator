import type IORedis from 'ioredis';
import config from '@/utils/config';
import logger from '@/utils/logger';
import type {
  NoteStyle,
  RenderMode,
  ScrollDirection,
  UserPrefs,
} from '@/utils/osu/userPrefs';
import { createRedisConnection } from './connection';
import type { ChannelSubscription, RenderResult } from './types';

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

function queueStatusMessageKey(renderKey: string): string {
  return key('render', 'queue-status-message', renderKey);
}

function queueStatusMessageField(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function userPrefsKey(userId: string): string {
  return key('user', 'prefs', userId);
}

const NOTE_STYLES = new Set<NoteStyle>(['bar', 'circle', 'arrow']);
const RENDER_MODES = new Set<RenderMode>(['last4min', 'preview']);
const SCROLL_DIRECTIONS = new Set<ScrollDirection>(['down', 'up']);
const DEFAULT_USER_PREFS: UserPrefs = {
  noteStyle: 'bar',
  noteColors: ['#ffffff', '#00aaff'],
  noteColorSpecial: '#ffdd00',
  renderMode: 'last4min',
  scrollDirection: 'down',
  strainOverlay: true,
};

function encodeUserPrefs(prefs: UserPrefs): Record<string, string> {
  return {
    noteStyle: prefs.noteStyle,
    noteColors: JSON.stringify(prefs.noteColors),
    noteColorSpecial: prefs.noteColorSpecial,
    renderMode: prefs.renderMode,
    scrollDirection: prefs.scrollDirection,
    strainOverlay: prefs.strainOverlay ? '1' : '0',
  };
}

function parseUserPrefsHash(raw: Record<string, string>): UserPrefs | null {
  const noteStyle = raw.noteStyle ?? DEFAULT_USER_PREFS.noteStyle;
  const renderMode = raw.renderMode ?? DEFAULT_USER_PREFS.renderMode;
  const scrollDirection =
    raw.scrollDirection ?? DEFAULT_USER_PREFS.scrollDirection;
  const noteColorSpecial =
    raw.noteColorSpecial ?? DEFAULT_USER_PREFS.noteColorSpecial;
  const strainOverlayRaw = raw.strainOverlay;

  if (!NOTE_STYLES.has(noteStyle as NoteStyle)) return null;
  if (!RENDER_MODES.has(renderMode as RenderMode)) return null;
  if (!SCROLL_DIRECTIONS.has(scrollDirection as ScrollDirection)) {
    return null;
  }

  let noteColors: string[];
  if (!raw.noteColors) {
    noteColors = [...DEFAULT_USER_PREFS.noteColors];
  } else {
    try {
      const parsed = JSON.parse(raw.noteColors);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => typeof item === 'string')
      ) {
        return null;
      }
      noteColors = parsed;
    } catch {
      return null;
    }
  }

  const strainOverlay =
    strainOverlayRaw === undefined
      ? DEFAULT_USER_PREFS.strainOverlay
      : strainOverlayRaw === '1' || strainOverlayRaw === 'true';

  return {
    noteStyle: noteStyle as NoteStyle,
    noteColors,
    noteColorSpecial,
    renderMode: renderMode as RenderMode,
    scrollDirection: scrollDirection as ScrollDirection,
    strainOverlay,
  };
}

function parseLegacyUserPrefs(raw: string): UserPrefs | null {
  try {
    const parsed = JSON.parse(raw) as UserPrefs;
    if (!NOTE_STYLES.has(parsed.noteStyle)) return null;
    if (!Array.isArray(parsed.noteColors)) return null;
    if (!parsed.noteColors.every((item) => typeof item === 'string'))
      return null;
    if (typeof parsed.noteColorSpecial !== 'string') return null;
    if (!RENDER_MODES.has(parsed.renderMode)) return null;
    if (!SCROLL_DIRECTIONS.has(parsed.scrollDirection)) return null;
    if (typeof parsed.strainOverlay !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWrongTypeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('WRONGTYPE');
}

function applyUserPrefsField(
  prefs: UserPrefs,
  field: keyof UserPrefs,
  value: string,
): UserPrefs {
  const next: UserPrefs = {
    ...prefs,
    noteColors: [...prefs.noteColors],
  };

  if (field === 'noteStyle') {
    if (!NOTE_STYLES.has(value as NoteStyle)) {
      throw new Error(`Invalid noteStyle value: ${value}`);
    }
    next.noteStyle = value as NoteStyle;
    return next;
  }

  if (field === 'noteColors') {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === 'string')
    ) {
      throw new Error('Invalid noteColors value');
    }
    next.noteColors = parsed;
    return next;
  }

  if (field === 'noteColorSpecial') {
    next.noteColorSpecial = value;
    return next;
  }

  if (field === 'renderMode') {
    if (!RENDER_MODES.has(value as RenderMode)) {
      throw new Error(`Invalid renderMode value: ${value}`);
    }
    next.renderMode = value as RenderMode;
    return next;
  }

  if (field === 'scrollDirection') {
    if (!SCROLL_DIRECTIONS.has(value as ScrollDirection)) {
      throw new Error(`Invalid scrollDirection value: ${value}`);
    }
    next.scrollDirection = value as ScrollDirection;
    return next;
  }

  next.strainOverlay = value === '1' || value === 'true';
  return next;
}

function getWrongTypeExecError(
  execResult: [Error | null, unknown][] | null,
): Error | null {
  if (!execResult) return null;

  for (const [err] of execResult) {
    if (err && isWrongTypeError(err)) {
      return err;
    }
  }

  return null;
}

function parseLegacyQueueStatusMap(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries: [string, string][] = [];
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      if (entryKey.length === 0 || typeof entryValue !== 'string') {
        continue;
      }
      entries.push([entryKey, entryValue]);
    }

    if (entries.length === 0) return null;
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function encodeSub(
  guildId: string,
  channelId: string,
  messageId?: string,
): string {
  return messageId
    ? `${guildId}:${channelId}:${messageId}`
    : `${guildId}:${channelId}`;
}

function decodeSub(token: string): ChannelSubscription | null {
  const [guildId, channelId, messageId] = token.split(':');
  if (!guildId || !channelId) return null;
  return { guildId, channelId, messageId };
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
  messageId?: string,
): Promise<void> {
  const token = encodeSub(guildId, channelId, messageId);
  const subKey = subscriptionsKey(renderKey);
  const client = getRedis();
  await client
    .multi()
    .sadd(subKey, token)
    .expire(subKey, Math.max(config.render.cacheTtlSec, 3_600))
    .exec();
}

export async function removeChannelSubscription(
  renderKey: string,
  guildId: string,
  channelId: string,
  messageId?: string,
): Promise<void> {
  await getRedis().srem(
    subscriptionsKey(renderKey),
    encodeSub(guildId, channelId, messageId),
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

export async function getQueueStatusMessageId(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<string | null> {
  const keyName = queueStatusMessageKey(renderKey);
  const field = queueStatusMessageField(guildId, channelId);
  const client = getRedis();

  try {
    return await client.hget(keyName, field);
  } catch (err) {
    if (!isWrongTypeError(err)) {
      throw err;
    }
  }

  const legacy = await client.get(keyName).catch(() => null);
  if (!legacy) return null;

  const map = parseLegacyQueueStatusMap(legacy);
  if (!map) {
    await client.del(keyName);
    return null;
  }

  await client
    .multi()
    .del(keyName)
    .hset(keyName, map)
    .expire(keyName, Math.max(config.render.cacheTtlSec, 3_600))
    .exec();

  return map[field] ?? null;
}

export async function setQueueStatusMessageId(
  renderKey: string,
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const keyName = queueStatusMessageKey(renderKey);
  const field = queueStatusMessageField(guildId, channelId);
  const client = getRedis();
  const execResult = await client
    .multi()
    .hset(keyName, field, messageId)
    .expire(keyName, Math.max(config.render.cacheTtlSec, 3_600))
    .exec();

  if (!getWrongTypeExecError(execResult)) {
    return;
  }

  await client
    .multi()
    .del(keyName)
    .hset(keyName, field, messageId)
    .expire(keyName, Math.max(config.render.cacheTtlSec, 3_600))
    .exec();
}

export async function clearQueueStatusMessageId(
  renderKey: string,
  guildId: string,
  channelId: string,
): Promise<void> {
  const keyName = queueStatusMessageKey(renderKey);
  const field = queueStatusMessageField(guildId, channelId);
  const client = getRedis();

  try {
    await client.hdel(keyName, field);
  } catch (err) {
    if (!isWrongTypeError(err)) {
      throw err;
    }
    await client.del(keyName);
  }
}

export async function getUserPrefsFromRedis(
  userId: string,
): Promise<UserPrefs | null> {
  const keyName = userPrefsKey(userId);
  const client = getRedis();

  try {
    const hash = await client.hgetall(keyName);
    if (Object.keys(hash).length > 0) {
      const parsedHash = parseUserPrefsHash(hash);
      if (parsedHash) return parsedHash;

      logger.warn(`Invalid user prefs hash payload for ${userId}`);
      await client.del(keyName);
      return null;
    }
  } catch (err) {
    if (!isWrongTypeError(err)) {
      logger.warn(
        `Failed to read user prefs hash for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  const raw = await client.get(keyName);
  if (!raw) return null;

  const legacy = parseLegacyUserPrefs(raw);
  if (!legacy) {
    logger.warn(`Invalid legacy user prefs payload for ${userId}`);
    await client.del(keyName);
    return null;
  }

  await setUserPrefsToRedis(userId, legacy);
  return legacy;
}

export async function setUserPrefsToRedis(
  userId: string,
  prefs: UserPrefs,
): Promise<void> {
  const keyName = userPrefsKey(userId);
  const encoded = encodeUserPrefs(prefs);
  await getRedis().multi().del(keyName).hset(keyName, encoded).exec();
}

export async function setUserPrefsFieldToRedis(
  userId: string,
  field: keyof UserPrefs,
  value: string,
): Promise<void> {
  const keyName = userPrefsKey(userId);
  const client = getRedis();

  try {
    await client.hset(keyName, field, value);
  } catch (err) {
    if (!isWrongTypeError(err)) {
      throw err;
    }

    const legacy = await client.get(keyName).catch(() => null);
    const basePrefs = (legacy ? parseLegacyUserPrefs(legacy) : null) ?? {
      ...DEFAULT_USER_PREFS,
      noteColors: [...DEFAULT_USER_PREFS.noteColors],
    };
    const nextPrefs = applyUserPrefsField(basePrefs, field, value);
    await setUserPrefsToRedis(userId, nextPrefs);
  }
}

export async function deleteUserPrefsFromRedis(userId: string): Promise<void> {
  await getRedis().del(userPrefsKey(userId));
}

export async function getScrollSpeedFromRedis(
  userId: string,
): Promise<number | null> {
  const raw = await getRedis().get(scrollSpeedKey(userId));
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function setScrollSpeedToRedis(
  userId: string,
  ms: number,
): Promise<void> {
  await getRedis().set(scrollSpeedKey(userId), String(ms));
}

export async function deleteScrollSpeedFromRedis(
  userId: string,
): Promise<void> {
  await getRedis().del(scrollSpeedKey(userId));
}

function scrollSpeedKey(userId: string): string {
  return key('user', 'scroll', userId);
}

export async function closeStoreConnection(): Promise<void> {
  if (!redis) return;

  const client = redis;
  redis = null;

  await client.quit().catch(() => {
    client.disconnect();
  });
}
