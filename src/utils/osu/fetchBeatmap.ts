import logger from '@/utils/logger';
import { FETCH_ATTEMPTS } from './constants';

const OSU_FILE_URL = (beatmapId: string) =>
  `https://osu.ppy.sh/osu/${beatmapId}`;

async function fetchOnce(beatmapId: string): Promise<string> {
  const res = await fetch(OSU_FILE_URL(beatmapId));
  if (!res.ok) {
    throw new Error(`Failed to fetch beatmap ${beatmapId}: HTTP ${res.status}`);
  }
  return res.text();
}

export async function fetchBeatmap(
  beatmapId: string,
  attempts = FETCH_ATTEMPTS,
): Promise<string> {
  try {
    return await fetchOnce(beatmapId);
  } catch (err) {
    if (attempts > 1) {
      logger.warn(
        `Retrying beatmap fetch for ${beatmapId} (${attempts - 1} attempts left)`,
      );
      return fetchBeatmap(beatmapId, attempts - 1);
    }
    throw err;
  }
}

/**
 * Extracts the preview start time (in ms) from the raw .osu file text.
 * Falls back to 0 if not found.
 */
export function extractPreviewTime(rawBeatmap: string): number {
  const match = rawBeatmap.match(/PreviewTime:\s*(-?\d+)/);
  return match ? Number(match[1]) : 0;
}

export interface BeatmapIds {
  beatmapSetId: string;
  beatmapId: string;
}

/**
 * Returns { beatmapSetId, beatmapId } from an osu! beatmap URL.
 * Throws if the URL doesn't match the expected format.
 */
export function parseOsuUrl(rawUrl: string): BeatmapIds {
  // New site: https://osu.ppy.sh/beatmapsets/{setId}#{mode}/{mapId}
  const newMatch = rawUrl.match(
    /osu\.ppy\.sh\/beatmapsets\/(\d+)(?:#(?:osu|taiko|fruits|mania)\/(\d+))?/,
  );
  if (newMatch) {
    const beatmapSetId = newMatch[1] ?? '';
    const beatmapId = newMatch[2] ?? '';
    if (!beatmapId) {
      throw new Error(
        'No specific difficulty selected in the URL. Please link to a specific difficulty.',
      );
    }
    return { beatmapSetId, beatmapId };
  }

  // Old site: https://osu.ppy.sh/b/{mapId}
  const oldBMatch = rawUrl.match(/osu\.ppy\.sh\/b\/(\d+)/);
  if (oldBMatch) {
    // For old /b/ links we only know the beatmap ID.
    // beatmapSetId will be resolved later from the .osu file's BeatmapSetID field.
    return { beatmapSetId: '', beatmapId: oldBMatch[1] ?? '' };
  }

  throw new Error(
    'Could not parse osu! URL. Please use a beatmapsets link with a specific difficulty.',
  );
}

/**
 * Extracts the BeatmapSetID from the raw .osu file content.
 * Returns empty string if not found.
 */
export function extractSetId(rawBeatmap: string): string {
  const match = rawBeatmap.match(/BeatmapSetID:\s*(\d+)/);
  return match?.[1] ?? '';
}
