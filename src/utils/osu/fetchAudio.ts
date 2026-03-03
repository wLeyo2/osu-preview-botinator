import { Parse } from 'unzipper';
import logger from '@/utils/logger';

/** Ordered list of mirrors tried in sequence until one succeeds. */
const MIRRORS: Array<{ name: string; url: (id: string) => string }> = [
  { name: 'catboy.best', url: (id) => `https://catboy.best/d/${id}` },
  { name: 'nerinyan.moe', url: (id) => `https://api.nerinyan.moe/d/${id}` },
  { name: 'osu.direct', url: (id) => `https://osu.direct/api/d/${id}` },
];

const MIRROR_TIMEOUT_MS = 20_000;

/** Audio file extensions recognised inside .osz archives */
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.flac'];

export interface AudioResult {
  /** Raw audio bytes */
  buffer: Buffer;
  /** File extension including dot, e.g. ".mp3" */
  ext: string;
  /** Original filename inside the archive */
  filename: string;
}

/**
 * Downloads the beatmapset archive and extracts the audio file.
 * Tries each mirror in order; moves to the next on any HTTP error or timeout.
 * Throws if all mirrors fail.
 */
export async function fetchAudioFromOsz(
  beatmapSetId: string,
  audioFilename?: string,
): Promise<AudioResult> {
  const failures: string[] = [];

  for (const mirror of MIRRORS) {
    const url = mirror.url(beatmapSetId);
    logger.info(`Downloading beatmapset from ${mirror.name}: ${url}`);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MIRROR_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: abort.signal });
      clearTimeout(timer);

      if (!res.ok) {
        const reason = `HTTP ${res.status}`;
        logger.warn(
          `[Mirror] ${mirror.name} failed (${reason}), trying next...`,
        );
        failures.push(`${mirror.name} (${reason})`);
        continue;
      }

      const archiveBuffer = Buffer.from(await res.arrayBuffer());
      // The underlying ArrayBuffer is released as soon as Buffer.from() wraps it.
      // Extract audio then let archiveBuffer go out of scope immediately.
      const result = await extractAudioFromBuffer(archiveBuffer, audioFilename);
      return result;
    } catch (err) {
      clearTimeout(timer);
      const reason = abort.signal.aborted
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : String(err);
      logger.warn(`[Mirror] ${mirror.name} failed (${reason}), trying next...`);
      failures.push(`${mirror.name} (${reason})`);
    }
  }

  throw new Error(
    `Failed to download beatmapset ${beatmapSetId} from all mirrors: ${failures.join(', ')}`,
  );
}

async function extractAudioFromBuffer(
  archiveBuffer: Buffer,
  preferredFilename?: string,
): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    const { Readable } = require('node:stream') as typeof import('node:stream');
    const readable = Readable.from(archiveBuffer);

    let resolved = false;
    const fallbackCandidates: {
      filename: string;
      ext: string;
      chunks: Buffer[];
    }[] = [];

    readable
      .pipe(Parse())
      .on('entry', (entry: import('unzipper').Entry) => {
        const filename = entry.path;
        const ext = getExtension(filename).toLowerCase();

        const isAudio = AUDIO_EXTENSIONS.includes(ext);
        const isPreferred =
          preferredFilename &&
          filename.toLowerCase() === preferredFilename.toLowerCase();

        if (!isAudio) {
          entry.autodrain();
          return;
        }

        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          const buf = Buffer.concat(chunks);

          if (isPreferred && !resolved) {
            resolved = true;
            resolve({ buffer: buf, ext, filename });
            return;
          }

          if (!isPreferred) {
            fallbackCandidates.push({ filename, ext, chunks: [buf] });
          }
        });
        entry.on('error', reject);
      })
      .on('finish', () => {
        if (resolved) return;

        // Use the first audio file found as fallback
        const candidate = fallbackCandidates[0];
        if (candidate) {
          resolve({
            buffer: Buffer.concat(candidate.chunks),
            ext: candidate.ext,
            filename: candidate.filename,
          });
        } else {
          reject(new Error('No audio file found in the beatmapset archive.'));
        }
      })
      .on('error', reject);
  });
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot) : '';
}

/**
 * Extracts the AudioFilename from the raw .osu file content.
 * Returns undefined if not found.
 */
export function extractAudioFilename(rawBeatmap: string): string | undefined {
  const match = rawBeatmap.match(/AudioFilename:\s*(.+)/);
  return match?.[1]?.trim();
}
