import type { SKRSContext2D } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import type { BeatmapMeta } from './parseBeatmap';

// ─── Layout constants ──────────────────────────────────────────────────────────

export const VIDEO_WIDTH = 360;
export const VIDEO_HEIGHT = 640; // 9:16 portrait

export const FPS = 30;

/** Default: how many ms of notes are visible in the playfield at once */
export const DEFAULT_SCROLL_MS = 1500;

const HEADER_HEIGHT = 100;
const HITLINE_Y = VIDEO_HEIGHT - 70;
const PLAYFIELD_HEIGHT = HITLINE_Y - HEADER_HEIGHT;

const COL_GAP = 2;
const NOTE_RADIUS = 4;
const NOTE_HEIGHT = 22;

// ─── Colour scheme ─────────────────────────────────────────────────────────────

const BG_COLOR = '#0d0d0d';
const HEADER_BG = 'rgba(0,0,0,0.82)';
const HITLINE_COLOR = '#ffffff';
const HITLINE_GLOW = 'rgba(255,255,255,0.18)';

const NOTE_COLORS = ['#00aaff', '#ffffff', '#00aaff', '#ffffff'];
const NOTE_COLOR_SPECIAL = '#ffdd00';

// Star rating colour thresholds (matches osu! website colouring)
function starColor(stars: number): string {
  if (stars < 2) return '#4fc3f7'; // light blue
  if (stars < 3) return '#81c784'; // green
  if (stars < 4) return '#ffee58'; // yellow
  if (stars < 5) return '#ffa726'; // orange
  if (stars < 6) return '#ef5350'; // red
  if (stars < 7) return '#ab47bc'; // purple
  return '#212121'; // black (expert+)
}

function getNoteColor(col: number, keys: number): string {
  const center = Math.floor(keys / 2);
  if (keys % 2 === 1 && col === center) return NOTE_COLOR_SPECIAL;
  return NOTE_COLORS[col % NOTE_COLORS.length] ?? '#00aaff';
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Cover-crop helper (object-fit: cover) ────────────────────────────────────

/**
 * Draws `img` into a rect on `ctx` using cover-fit semantics:
 * the image is scaled to fill the target rect, centred, and clipped.
 */
function drawCoverFit(
  ctx: SKRSContext2D,
  img: import('@napi-rs/canvas').Image,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const scaleX = dw / img.width;
  const scaleY = dh / img.height;
  const scale = Math.max(scaleX, scaleY);

  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;

  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// ─── Round-rect helper ─────────────────────────────────────────────────────────

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ─── Main render function ──────────────────────────────────────────────────────

/**
 * Renders all frames for the mania preview video.
 *
 * @param meta       Parsed beatmap metadata including notes
 * @param coverImage Optional cover image as a Buffer (JPEG/PNG)
 * @param startMs    Map time (ms) at the first frame — typically 0 or slightly negative
 * @param durationMs How many milliseconds of video to generate
 * @param scrollMs   Visible time window (ms); smaller = faster scroll
 * @param onFrame    Callback with raw RGBA pixel data per frame
 */
export async function renderFrames(
  meta: BeatmapMeta,
  coverImage: Buffer | null,
  startMs: number,
  durationMs: number,
  scrollMs: number,
  onFrame: (
    rgbaData: Buffer,
    frameIndex: number,
    totalFrames: number,
  ) => Promise<void>,
): Promise<void> {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const keys = Math.max(1, meta.keys);
  const colWidth = Math.floor((VIDEO_WIDTH - COL_GAP * (keys + 1)) / keys);

  function colX(col: number): number {
    return COL_GAP * (col + 1) + col * colWidth;
  }

  function noteY(noteTimeMs: number, currentMs: number): number {
    const msAhead = noteTimeMs - currentMs;
    const fraction = msAhead / scrollMs; // 0 = at hit line, 1 = top
    return HITLINE_Y - fraction * PLAYFIELD_HEIGHT;
  }

  // Pre-load cover image
  let coverLoaded: import('@napi-rs/canvas').Image | null = null;
  if (coverImage) {
    try {
      const { loadImage } = await import('@napi-rs/canvas');
      coverLoaded = await loadImage(coverImage);
    } catch {
      // cover is optional
    }
  }

  const starsText = `${meta.stars.toFixed(2)} ★`;
  const starCol = starColor(meta.stars);

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const currentMs = startMs + (frameIdx / FPS) * 1000;

    // ── Background (cover-cropped) ────────────────────────────────────────────
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    if (coverLoaded) {
      ctx.globalAlpha = 0.18;
      drawCoverFit(ctx, coverLoaded, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
      ctx.globalAlpha = 1;
      // Darken overlay so notes stay legible
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    }

    // ── Column separators ─────────────────────────────────────────────────────
    for (let col = 0; col <= keys; col++) {
      const x = col === 0 ? 0 : colX(col - 1) + colWidth;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, HEADER_HEIGHT, COL_GAP, PLAYFIELD_HEIGHT + 70);
    }

    // ── Notes ─────────────────────────────────────────────────────────────────
    const windowStart = currentMs - 200;
    const windowEnd = currentMs + scrollMs + 200;

    for (const note of meta.notes) {
      if (note.startTime > windowEnd) break;
      if (note.endTime < windowStart) continue;

      const color = getNoteColor(note.column, keys);
      const x = colX(note.column);
      const w = colWidth;

      if (note.isHold) {
        const startY = noteY(note.startTime, currentMs);
        const endY = noteY(note.endTime, currentMs);
        const top = Math.min(startY, endY);
        const height = Math.abs(endY - startY);

        // Hold body
        ctx.fillStyle = hexToRgba(color, 0.4);
        const bodyTop = Math.max(top, HEADER_HEIGHT);
        const bodyH = Math.min(top + height, HITLINE_Y + NOTE_HEIGHT) - bodyTop;
        if (bodyH > 0) {
          ctx.fillRect(x + 2, bodyTop, w - 4, bodyH);
        }

        // Head cap
        if (
          startY >= HEADER_HEIGHT - NOTE_HEIGHT &&
          startY <= HITLINE_Y + NOTE_HEIGHT
        ) {
          ctx.fillStyle = color;
          roundRect(ctx, x, startY - NOTE_HEIGHT, w, NOTE_HEIGHT, NOTE_RADIUS);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fillRect(x + 2, startY - NOTE_HEIGHT + 2, w - 4, 4);
        }

        // Tail cap
        if (endY >= HEADER_HEIGHT && endY <= HITLINE_Y + NOTE_HEIGHT) {
          ctx.fillStyle = hexToRgba(color, 0.8);
          roundRect(ctx, x, endY - 4, w, 8, NOTE_RADIUS);
          ctx.fill();
        }
      } else {
        const y = noteY(note.startTime, currentMs);
        if (y < HEADER_HEIGHT - NOTE_HEIGHT || y > HITLINE_Y + NOTE_HEIGHT)
          continue;

        ctx.fillStyle = color;
        roundRect(ctx, x, y - NOTE_HEIGHT, w, NOTE_HEIGHT, NOTE_RADIUS);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillRect(x + 2, y - NOTE_HEIGHT + 2, w - 4, 4);
      }
    }

    // ── Hit line ──────────────────────────────────────────────────────────────
    ctx.fillStyle = HITLINE_GLOW;
    ctx.fillRect(0, HITLINE_Y - 8, VIDEO_WIDTH, 16);
    ctx.fillStyle = HITLINE_COLOR;
    ctx.fillRect(0, HITLINE_Y - 1, VIDEO_WIDTH, 2);

    // ── Header ────────────────────────────────────────────────────────────────
    ctx.fillStyle = HEADER_BG;
    ctx.fillRect(0, 0, VIDEO_WIDTH, HEADER_HEIGHT);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`${meta.artist} - ${meta.title}`, 12, 36, VIDEO_WIDTH - 24);

    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#cccccc';
    ctx.fillText(`[${meta.version}]  •  ${keys}K`, 12, 56, VIDEO_WIDTH - 24);

    ctx.fillStyle = '#888888';
    ctx.font = '11px sans-serif';
    ctx.fillText(`mapped by ${meta.creator}`, 12, 74, VIDEO_WIDTH - 24);

    // ── Star rating badge (top-right of header) ───────────────────────────────
    const badgePad = 8;
    const badgeH = 22;
    ctx.font = 'bold 13px sans-serif';
    const starTextW = ctx.measureText(starsText).width;
    const badgeW = starTextW + badgePad * 2;
    const badgeX = VIDEO_WIDTH - badgeW - 10;
    const badgeY = HEADER_HEIGHT / 2 - badgeH / 2;

    // Pill background
    ctx.fillStyle = starCol;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();

    // Text on pill — dark for light backgrounds, white otherwise
    const isLight = meta.stars < 3;
    ctx.fillStyle = isLight ? '#1a1a1a' : '#ffffff';
    ctx.fillText(starsText, badgeX + badgePad, badgeY + 15);

    // ── Extract raw RGBA and emit ─────────────────────────────────────────────
    const imageData = ctx.getImageData(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    const rgbaBuffer = Buffer.from(imageData.data.buffer);
    await onFrame(rgbaBuffer, frameIdx, totalFrames);
  }
}
