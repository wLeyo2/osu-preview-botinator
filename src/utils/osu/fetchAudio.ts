import { Readable } from 'node:stream';
import { Parse } from 'unzipper';
import config from '@/utils/config';
import logger from '@/utils/logger';

/** Ordered list of mirrors tried with hedged start delays. */
const MIRRORS: Array<{ name: string; url: (id: string) => string }> = [
  { name: 'catboy.best', url: (id) => `https://catboy.best/d/${id}` },
  { name: 'nerinyan.moe', url: (id) => `https://api.nerinyan.moe/d/${id}` },
  { name: 'osu.direct', url: (id) => `https://osu.direct/api/d/${id}` },
];

/** Audio file extensions recognised inside .osz archives */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav', '.flac']);

const mirrorCooldownUntil = new Map<string, number>();

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
 * Mirrors are started with a hedge delay (mirror 2 starts shortly after mirror 1, etc.)
 * so slow mirrors don't block the whole request.
 */
export async function fetchAudioFromOsz(
  beatmapSetId: string,
  audioFilename?: string,
): Promise<AudioResult> {
  const failures: string[] = [];
  const activeControllers = new Set<AbortController>();
  let winnerSelected = false;

  const attempts = MIRRORS.map((mirror, index) =>
    (async (): Promise<AudioResult> => {
      const delayMs = index * config.render.audioHedgeDelayMs;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      if (winnerSelected) {
        throw new Error('skipped-after-winner');
      }

      const cooldownRemainingSec = getMirrorCooldownRemainingSec(mirror.name);
      if (cooldownRemainingSec > 0) {
        const reason = `cooldown ${cooldownRemainingSec}s`;
        failures.push(`${mirror.name} (${reason})`);
        throw new Error(reason);
      }

      const controller = new AbortController();
      activeControllers.add(controller);

      try {
        const result = await fetchAudioFromMirror(
          mirror,
          beatmapSetId,
          audioFilename,
          controller.signal,
        );

        winnerSelected = true;
        clearMirrorCooldown(mirror.name);
        return result;
      } catch (error) {
        if (winnerSelected && controller.signal.aborted) {
          throw error;
        }

        const reason =
          error instanceof Error
            ? normalizeFailureReason(error.message)
            : String(error);
        logger.warn(
          `[Mirror] ${mirror.name} failed (${reason}), trying next...`,
        );
        failures.push(`${mirror.name} (${reason})`);
        applyMirrorCooldown(mirror.name);
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        activeControllers.delete(controller);
      }
    })(),
  );

  try {
    const result = await Promise.any(attempts);

    for (const controller of activeControllers) {
      controller.abort();
    }

    return result;
  } catch {
    for (const controller of activeControllers) {
      controller.abort();
    }

    throw new Error(
      `Failed to download beatmapset ${beatmapSetId} from all mirrors: ${failures.join(', ')}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMirrorCooldownRemainingSec(name: string): number {
  const until = mirrorCooldownUntil.get(name) ?? 0;
  if (until <= Date.now()) return 0;
  return Math.ceil((until - Date.now()) / 1000);
}

function applyMirrorCooldown(name: string): void {
  if (config.render.mirrorCooldownSec <= 0) return;

  const until = Date.now() + config.render.mirrorCooldownSec * 1000;
  mirrorCooldownUntil.set(name, until);
}

function clearMirrorCooldown(name: string): void {
  mirrorCooldownUntil.delete(name);
}

function normalizeFailureReason(reason: string): string {
  if (/aborted|aborterror/i.test(reason)) return 'aborted';
  return reason;
}

async function fetchAudioFromMirror(
  mirror: { name: string; url: (id: string) => string },
  beatmapSetId: string,
  audioFilename: string | undefined,
  signal: AbortSignal,
): Promise<AudioResult> {
  const url = mirror.url(beatmapSetId);
  logger.info(`Downloading beatmapset from ${mirror.name}: ${url}`);

  const requestAbort = new AbortController();
  let headerTimedOut = false;
  let totalTimedOut = false;
  let abortedByParent = false;

  const onAbort = () => {
    abortedByParent = true;
    requestAbort.abort();
  };

  signal.addEventListener('abort', onAbort, { once: true });

  const headerTimeout = setTimeout(() => {
    headerTimedOut = true;
    requestAbort.abort();
  }, config.render.audioHeaderTimeoutMs);
  const totalTimeout = setTimeout(() => {
    totalTimedOut = true;
    requestAbort.abort();
  }, config.render.audioTotalTimeoutMs);

  try {
    const response = await fetch(url, { signal: requestAbort.signal });
    clearTimeout(headerTimeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const archiveStream = toNodeReadable(response.body);
    if (!archiveStream) {
      throw new Error('Beatmap archive response has no readable body.');
    }

    return await extractAudioFromStream(
      archiveStream,
      audioFilename,
      requestAbort.signal,
    );
  } catch (error) {
    if (headerTimedOut) {
      throw new Error(
        `header timeout (${config.render.audioHeaderTimeoutMs}ms)`,
      );
    }

    if (totalTimedOut) {
      throw new Error(`total timeout (${config.render.audioTotalTimeoutMs}ms)`);
    }

    if (abortedByParent) {
      throw new Error('aborted');
    }

    throw error;
  } finally {
    clearTimeout(headerTimeout);
    clearTimeout(totalTimeout);
    signal.removeEventListener('abort', onAbort);
  }
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
  preferredFilename: string | undefined,
  signal: AbortSignal,
): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    const parser = Parse();

    let settled = false;
    let streamFinished = false;
    let pendingEntries = 0;
    let fallbackCandidate: AudioResult | null = null;
    let lastProgressAt = Date.now();
    const normalizedPreferred = preferredFilename?.toLowerCase() ?? '';
    const hasPreferred = normalizedPreferred.length > 0;

    const stallCheckIntervalMs = Math.max(
      500,
      Math.floor(config.render.audioStallTimeoutMs / 2),
    );
    const stallTimer = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastProgressAt < config.render.audioStallTimeoutMs)
        return;
      rejectOnce(
        new Error(`stalled for ${config.render.audioStallTimeoutMs}ms`),
      );
    }, stallCheckIntervalMs);

    function cleanup(): void {
      clearInterval(stallTimer);
      signal.removeEventListener('abort', onAbort);
      archiveStream.removeAllListeners('error');
      archiveStream.removeListener('data', onProgress);
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

    function onProgress(): void {
      lastProgressAt = Date.now();
    }

    function onAbort(): void {
      rejectOnce(new Error('aborted'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
    archiveStream.on('error', rejectOnce);
    archiveStream.on('data', onProgress);

    parser.on('entry', (entry: import('unzipper').Entry) => {
      const filename = entry.path;
      const ext = getExtension(filename).toLowerCase();
      const isAudio = AUDIO_EXTENSIONS.has(ext);
      if (!isAudio) {
        entry.autodrain();
        return;
      }

      const filenameLower = filename.toLowerCase();
      const wantsPreferred =
        hasPreferred && filenameLower === normalizedPreferred;
      const takeImmediate = !hasPreferred;
      const captureForFallback =
        hasPreferred && !wantsPreferred && !fallbackCandidate;

      if (!wantsPreferred && !takeImmediate && !captureForFallback) {
        entry.autodrain();
        return;
      }

      pendingEntries += 1;
      const chunks: Buffer[] = [];

      entry.on('data', (chunk: Buffer) => {
        lastProgressAt = Date.now();
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

        if (wantsPreferred || takeImmediate) {
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
