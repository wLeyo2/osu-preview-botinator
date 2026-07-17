import { Unzip, type UnzipFile, UnzipInflate } from 'fflate';
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

    const body = response.body;
    if (!body) {
      throw new Error('Beatmap archive response has no readable body.');
    }

    return await extractAudioFromStream(body, audioFilename, requestAbort);
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

/**
 * Streams the .osz through fflate's Unzip, resolving as soon as the audio
 * entry is fully inflated and aborting the rest of the download.
 */
async function extractAudioFromStream(
  body: ReadableStream<Uint8Array>,
  preferredFilename: string | undefined,
  requestAbort: AbortController,
): Promise<AudioResult> {
  const reader = body.getReader();
  const normalizedPreferred = normalizeArchivePath(preferredFilename ?? '');
  const hasPreferred = normalizedPreferred.length > 0;
  let streamDone = false;
  let settled = false;
  let fallbackCandidate: AudioResult | null = null;
  let resolveResult!: (result: AudioResult) => void;
  let rejectResult!: (error: Error) => void;

  const resultPromise = new Promise<AudioResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  function resolveOnce(result: AudioResult) {
    if (settled) return;
    settled = true;
    resolveResult(result);
  }

  function rejectOnce(error: unknown) {
    if (settled) return;
    settled = true;
    rejectResult(error instanceof Error ? error : new Error(String(error)));
  }

  const unzip = new Unzip((file) => {
    handleZipEntry(file, {
      normalizedPreferred,
      hasPreferred,
      get fallbackCandidate() {
        return fallbackCandidate;
      },
      set fallbackCandidate(result) {
        fallbackCandidate = result;
      },
      resolveOnce,
      rejectOnce,
    });
  });
  unzip.register(UnzipInflate);

  try {
    while (true) {
      if (settled) break;
      const { done, value } = await readWithStallTimeout(
        reader,
        config.render.audioStallTimeoutMs,
        requestAbort,
      );
      if (done) {
        streamDone = true;
        unzip.push(new Uint8Array(), true);
        break;
      }
      if (value) unzip.push(value, false);
    }

    if (!settled) {
      if (fallbackCandidate) resolveOnce(fallbackCandidate);
      else
        rejectOnce(new Error('No audio file found in the beatmapset archive.'));
    }
  } catch (err) {
    rejectOnce(err);
  } finally {
    if (!streamDone) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return resultPromise;
}

function handleZipEntry(
  file: UnzipFile,
  state: {
    normalizedPreferred: string;
    hasPreferred: boolean;
    fallbackCandidate: AudioResult | null;
    resolveOnce: (result: AudioResult) => void;
    rejectOnce: (error: unknown) => void;
  },
): void {
  const filename = file.name;
  const ext = getExtension(filename).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return;

  const filenameLower = normalizeArchivePath(filename);
  const wantsPreferred =
    state.hasPreferred &&
    (filenameLower === state.normalizedPreferred ||
      filenameLower.endsWith(`/${state.normalizedPreferred}`));
  const takeImmediate = !state.hasPreferred;
  const captureForFallback =
    state.hasPreferred && !wantsPreferred && !state.fallbackCandidate;

  if (!wantsPreferred && !takeImmediate && !captureForFallback) return;

  const entryChunks: Buffer[] = [];
  file.ondata = (err, chunk, final) => {
    if (err) {
      state.rejectOnce(err);
      return;
    }
    if (chunk.length > 0) entryChunks.push(Buffer.from(chunk));
    if (!final) return;

    const result: AudioResult = {
      buffer: Buffer.concat(entryChunks),
      ext,
      filename,
    };
    if (wantsPreferred || takeImmediate) {
      state.resolveOnce(result);
      return;
    }
    if (!state.fallbackCandidate) state.fallbackCandidate = result;
  };

  try {
    file.start();
  } catch (err) {
    state.rejectOnce(err);
  }
}

async function readWithStallTimeout(
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> },
  timeoutMs: number,
  requestAbort: AbortController,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const readPromise = reader.read();
  // If the stall timer wins the race, the abort makes this read reject later
  // with nobody awaiting it — swallow that to avoid an unhandled rejection.
  readPromise.catch(() => {});
  try {
    return await Promise.race([
      readPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          requestAbort.abort();
          reject(new Error(`stalled for ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeArchivePath(filename: string): string {
  return filename.trim().replaceAll('\\', '/').toLowerCase();
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
