import { Parse } from 'unzipper';
import logger from '@/utils/logger';

const CATBOY_DOWNLOAD_URL = (beatmapSetId: string) =>
  `https://catboy.best/d/${beatmapSetId}`;

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
 * Downloads the beatmapset archive from catboy.best and extracts
 * the audio file referenced by `audioFilename` in the .osu file.
 *
 * If `audioFilename` is not provided or not found, falls back to
 * the first audio file found in the archive.
 */
export async function fetchAudioFromOsz(
  beatmapSetId: string,
  audioFilename?: string,
): Promise<AudioResult> {
  const url = CATBOY_DOWNLOAD_URL(beatmapSetId);
  logger.info(`Downloading beatmapset from ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download beatmapset ${beatmapSetId}: HTTP ${res.status}`,
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const archiveBuffer = Buffer.from(arrayBuffer);

  return extractAudioFromBuffer(archiveBuffer, audioFilename);
}

async function extractAudioFromBuffer(
  archiveBuffer: Buffer,
  preferredFilename?: string,
): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    const { Readable } = require('stream') as typeof import('stream');
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
