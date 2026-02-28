import { DEFAULT_SCROLL_MS } from './renderer';

/**
 * Per-user scroll speed setting (ms of notes visible at once).
 * Lower = faster scroll, higher = slower.
 * Stored in memory; resets on bot restart.
 */
const userScrollMs = new Map<string, number>();

export const SCROLL_MS_MIN = 100;
export const SCROLL_MS_MAX = 1500;

export function getScrollMs(userId: string): number {
  return userScrollMs.get(userId) ?? DEFAULT_SCROLL_MS;
}

export function setScrollMs(userId: string, ms: number): void {
  const clamped = Math.max(SCROLL_MS_MIN, Math.min(SCROLL_MS_MAX, ms));
  userScrollMs.set(userId, clamped);
}

export const SPEED_PRESETS: Record<string, number> = {
  fast: 350,
  medium: 600,
  slow: 1000,
};
