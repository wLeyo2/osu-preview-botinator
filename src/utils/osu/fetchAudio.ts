import { Readable } from 'node:stream';
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

      const archiveStream = toNodeReadable(res.body);
      if (!archiveStream) {
        throw new Error('Beatmap archive response has no readable body.');
      }

      const result = await extractAudioFromStream(archiveStream, audioFilename);
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

function toNodeReadable(
  body: ReadableStream<Uint8Array> | null,
): Readable | null {
  if (!body) return null;

  if (typeof Readable.fromWeb === 'function') {
    return Readable.fromWeb(body as globalThis.ReadableStream<Uint8Array>);
  }

  return Readable.from(
    (async function* streamChunks() {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );
}

async function extractAudioFromStream(
  archiveStream: Readable,
  preferredFilename?: string,
): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    const parser = Parse();

    let settled = false;
    let streamFinished = false;
    let pendingEntries = 0;
    let fallbackCandidate: AudioResult | null = null;

    function cleanup(): void {
      archiveStream.removeAllListeners('error');
      parser.removeAllListeners();
      archiveStream.unpipe(parser);
      parser.destroy();
    }

    function resolveOnce(result: AudioResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function rejectOnce(error: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function maybeResolveFallback(): void {
      if (settled || !streamFinished || pendingEntries > 0) return;
      if (fallbackCandidate) {
        resolveOnce(fallbackCandidate);
        return;
      }
      rejectOnce(new Error('No audio file found in the beatmapset archive.'));
    }

    archiveStream.on('error', rejectOnce);

    parser.on('entry', (entry: import('unzipper').Entry) => {
      const filename = entry.path;
      const ext = getExtension(filename).toLowerCase();
      const isAudio = AUDIO_EXTENSIONS.includes(ext);
      if (!isAudio) {
        entry.autodrain();
        return;
      }

      const wantsPreferred =
        Boolean(preferredFilename) &&
        filename.toLowerCase() === preferredFilename?.toLowerCase();
      const captureForFallback = !wantsPreferred && !fallbackCandidate;

      if (!wantsPreferred && !captureForFallback) {
        entry.autodrain();
        return;
      }

      pendingEntries += 1;
      const chunks: Buffer[] = [];

      entry.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      entry.on('error', rejectOnce);

      entry.on('end', () => {
        pendingEntries -= 1;
        if (settled) return;

        const result: AudioResult = {
          buffer: Buffer.concat(chunks),
          ext,
          filename,
        };

        if (wantsPreferred) {
          resolveOnce(result);
          return;
        }

        if (!fallbackCandidate) {
          fallbackCandidate = result;
        }

        maybeResolveFallback();
      });
    });

    parser.on('error', rejectOnce);
    parser.on('close', () => {
      streamFinished = true;
      maybeResolveFallback();
    });

    archiveStream.pipe(parser);
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
