import { DEFAULT_SCROLL_MS } from './renderer';

/**
 * Per-user scroll speed setting (ms of notes visible at once).
 * Lower = faster scroll, higher = slower.
 * Stored in memory with write-through to Redis; persists across restarts.
 */
const userScrollMs = new Map<string, number>();
const redisCacheMisses = new Set<string>();

async function loadScrollSpeedFromRedis(
  userId: string,
): Promise<number | null> {
  if (redisCacheMisses.has(userId)) {
    return null;
  }

  try {
    const { getScrollSpeedFromRedis } = await import('@/queue/store');
    const ms = await getScrollSpeedFromRedis(userId);
    if (ms === null) {
      redisCacheMisses.add(userId);
    }
    return ms;
  } catch (_error) {
    return null;
  }
}

export const SCROLL_MS_MIN = 100;
export const SCROLL_MS_MAX = 1500;

export async function getScrollMs(userId: string): Promise<number> {
  const cached = userScrollMs.get(userId);
  if (cached !== undefined) return cached;

  const fromRedis = await loadScrollSpeedFromRedis(userId);
  if (fromRedis !== null) {
    userScrollMs.set(userId, fromRedis);
    return fromRedis;
  }

  return DEFAULT_SCROLL_MS;
}

export async function setScrollMs(userId: string, ms: number): Promise<void> {
  const clamped = Math.max(SCROLL_MS_MIN, Math.min(SCROLL_MS_MAX, ms));
  userScrollMs.set(userId, clamped);

  try {
    const { setScrollSpeedToRedis } = await import('@/queue/store');
    await setScrollSpeedToRedis(userId, clamped);
  } catch (_error) {}
}

export const SPEED_PRESETS: Record<string, number> = {
  fast: 350,
  medium: 600,
  slow: 1000,
};
