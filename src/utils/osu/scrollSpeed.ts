import { DEFAULT_SCROLL_MS } from './renderer';

/**
 * Per-guild scroll speed setting (ms of notes visible at once).
 * Lower = faster scroll, higher = slower.
 * Stored in memory; resets on bot restart.
 */
const guildScrollMs = new Map<string, number>();

export const SCROLL_MS_MIN = 400;
export const SCROLL_MS_MAX = 4000;

export function getScrollMs(guildId: string): number {
  return guildScrollMs.get(guildId) ?? DEFAULT_SCROLL_MS;
}

export function setScrollMs(guildId: string, ms: number): void {
  const clamped = Math.max(SCROLL_MS_MIN, Math.min(SCROLL_MS_MAX, ms));
  guildScrollMs.set(guildId, clamped);
}

/**
 * Convert a human-readable speed label to a scrollMs value.
 * 'fast' = 600 ms (very fast scroll), 'slow' = 3000 ms.
 */
export const SPEED_PRESETS: Record<string, number> = {
  'very fast': 500,
  fast: 800,
  normal: DEFAULT_SCROLL_MS,
  slow: 2500,
  'very slow': 3500,
};
