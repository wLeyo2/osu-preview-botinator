import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import type { SkinMap } from './noteAssets';
import { loadNoteAssets } from './noteAssets';
import type { BeatmapMeta } from './parseBeatmap';
import type { NoteStyle } from './userPrefs';
import {
  NOTE_COLOR_SPECIAL_DEFAULT,
  NOTE_COLORS_DEFAULT,
  NOTE_STYLE_DEFAULT,
} from './userPrefs';

// ─── Layout constants ──────────────────────────────────────────────────────────

export const VIDEO_WIDTH = 360;
export const VIDEO_HEIGHT = 640; // 9:16 portrait

export const FPS = 60;

/** Default: how many ms of notes are visible in the playfield at once */
export const DEFAULT_SCROLL_MS = 500;

const HEADER_HEIGHT = 100;
const HITLINE_Y = VIDEO_HEIGHT - 70;
const PLAYFIELD_HEIGHT = HITLINE_Y - HEADER_HEIGHT;

const COL_GAP = 2;
const NOTE_HEIGHT = 22;

// ─── Colour scheme ─────────────────────────────────────────────────────────────

const BG_COLOR = '#0d0d0d';
const HEADER_BG = 'rgba(0,0,0,0.82)';
const HITLINE_COLOR = '#ffffff';
const HITLINE_GLOW = 'rgba(255,255,255,0.18)';

// Star rating colour thresholds (matches osu! website colouring)
function starColor(stars: number): string {
  if (stars < 2) return '#4fc3f7';
  if (stars < 3) return '#81c784';
  if (stars < 4) return '#ffee58';
  if (stars < 5) return '#ffa726';
  if (stars < 6) return '#ef5350';
  if (stars < 7) return '#ab47bc';
  return '#212121';
}

function getNoteColor(
  col: number,
  keys: number,
  noteColors: string[],
  noteColorSpecial: string,
): string {
  const center = Math.floor(keys / 2);
  if (keys % 2 === 1 && col === center) return noteColorSpecial;
  return noteColors[col % noteColors.length] ?? '#00aaff';
}

// ─── Cover-crop helper (object-fit: cover) ────────────────────────────────────

function drawCoverFit(
  ctx: SKRSContext2D,
  img: Image,
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

// ─── Round-rect helper (used for hold body/tail, hit line) ────────────────────

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

// ─── Asset-based note drawing ─────────────────────────────────────────────────

/**
 * Per-render cache of offscreen canvases keyed by "WxH".
 * Reusing canvases eliminates thousands of native Skia allocations per encode,
 * preventing the native-heap growth that isn't visible to the JS GC.
 */
type OffscreenCache = Map<string, { canvas: Canvas; ctx: SKRSContext2D }>;

function getCachedCanvas(
  cache: OffscreenCache,
  w: number,
  h: number,
): { canvas: Canvas; ctx: SKRSContext2D } {
  const key = `${w}x${h}`;
  let entry = cache.get(key);
  if (!entry) {
    const canvas = createCanvas(w, h);
    entry = { canvas, ctx: canvas.getContext('2d') };
    cache.set(key, entry);
  }
  return entry;
}

/**
 * Draws a note asset tinted to `color` at position (x, topY) with size (w, h).
 * Reuses a cached offscreen canvas to avoid allocating a new native canvas per call.
 *
 * Tinting strategy:
 *   1. Clear + draw the white asset onto the offscreen canvas.
 *   2. source-atop fill with color — paints color onto non-transparent pixels only.
 *   3. Composite result onto main canvas with source-over.
 */
function drawTintedAsset(
  ctx: SKRSContext2D,
  asset: Image,
  color: string,
  alpha: number,
  x: number,
  topY: number,
  w: number,
  h: number,
  cache: OffscreenCache,
): void {
  const { canvas: off, ctx: offCtx } = getCachedCanvas(cache, w, h);

  offCtx.clearRect(0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-over';
  offCtx.drawImage(asset, 0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-atop';
  offCtx.fillStyle = color;
  offCtx.fillRect(0, 0, w, h);
  offCtx.globalCompositeOperation = 'source-over'; // reset for next use

  ctx.globalAlpha = alpha;
  ctx.drawImage(off, x, topY);
  ctx.globalAlpha = 1;
}

/**
 * Draws a tinted hold-body asset clipped to `bodyH` pixels.
 *
 * The body asset is designed to be stretched vertically, so we render it
 * once at full PLAYFIELD_HEIGHT into a cached canvas, then blit only the
 * top `bodyH` rows onto the main canvas. This means hold body never
 * allocates a new canvas regardless of how many holds or frames there are.
 * Cache key: "body_W" — one entry per column width, shared across all frames.
 */
function drawBodyAsset(
  ctx: SKRSContext2D,
  asset: Image,
  color: string,
  alpha: number,
  x: number,
  bodyTop: number,
  w: number,
  bodyH: number,
  cache: OffscreenCache,
): void {
  const key = `body_${w}`;
  let entry = cache.get(key);
  if (!entry) {
    const canvas = createCanvas(w, PLAYFIELD_HEIGHT);
    entry = { canvas, ctx: canvas.getContext('2d') };
    cache.set(key, entry);
  }
  const { canvas: off, ctx: offCtx } = entry;

  // Re-tint whenever color changes (cheap — just two fillRect calls)
  offCtx.clearRect(0, 0, w, PLAYFIELD_HEIGHT);
  offCtx.globalCompositeOperation = 'source-over';
  offCtx.drawImage(asset, 0, 0, w, PLAYFIELD_HEIGHT);
  offCtx.globalCompositeOperation = 'source-atop';
  offCtx.fillStyle = color;
  offCtx.fillRect(0, 0, w, PLAYFIELD_HEIGHT);
  offCtx.globalCompositeOperation = 'source-over';

  // Blit only the needed rows (source crop, no new allocation)
  ctx.globalAlpha = alpha;
  ctx.drawImage(off, 0, 0, w, bodyH, x, bodyTop, w, bodyH);
  ctx.globalAlpha = 1;
}

/**
 * Resolves target draw rect for a note asset.
 *
 * - Bar:    full column width × NOTE_HEIGHT
 * - Arrow:  full column width × ARROW_NOTE_HEIGHT (taller so chevron reads clearly)
 * - Circle: colWidth × colWidth square (centred horizontally in column)
 */
function noteDrawRect(
  style: NoteStyle,
  x: number,
  bottomY: number,
  colWidth: number,
): { x: number; topY: number; w: number; h: number } {
  if (style === 'circle') {
    return {
      x,
      topY: bottomY - colWidth,
      w: colWidth,
      h: colWidth,
    };
  }
  if (style === 'arrow') {
    // Square filling the full column width — same geometry as circle
    return {
      x,
      topY: bottomY - colWidth,
      w: colWidth,
      h: colWidth,
    };
  }
  // bar: full width × NOTE_HEIGHT
  return { x, topY: bottomY - NOTE_HEIGHT, w: colWidth, h: NOTE_HEIGHT };
}

function drawNoteAsset(
  ctx: SKRSContext2D,
  skin: SkinMap,
  style: NoteStyle,
  x: number,
  bottomY: number,
  colWidth: number,
  color: string,
  cache: OffscreenCache,
  alpha = 1,
): void {
  const asset = skin[style].note;
  const { x: dx, topY, w, h } = noteDrawRect(style, x, bottomY, colWidth);
  drawTintedAsset(ctx, asset, color, alpha, dx, topY, w, h, cache);
}

function drawHoldHeadAsset(
  ctx: SKRSContext2D,
  skin: SkinMap,
  style: NoteStyle,
  x: number,
  bottomY: number,
  colWidth: number,
  color: string,
  cache: OffscreenCache,
): void {
  const asset = skin[style].holdHead;
  const { x: dx, topY, w, h } = noteDrawRect(style, x, bottomY, colWidth);
  drawTintedAsset(ctx, asset, color, 1, dx, topY, w, h, cache);
}

function drawHoldTailAsset(
  ctx: SKRSContext2D,
  skin: SkinMap,
  style: NoteStyle,
  x: number,
  tailY: number,
  colWidth: number,
  color: string,
  cache: OffscreenCache,
): void {
  const asset = skin[style].holdTail;
  // Tail is always rendered as a thin horizontal bar, 8px tall, centred on tailY
  const tailH = 8;
  drawTintedAsset(
    ctx,
    asset,
    color,
    0.85,
    x,
    tailY - tailH / 2,
    colWidth,
    tailH,
    cache,
  );
}

// ─── Main render function ──────────────────────────────────────────────────────

export interface RenderOptions {
  noteStyle?: NoteStyle;
  noteColors?: string[];
  noteColorSpecial?: string;
}

/**
 * Renders all frames for the mania preview video.
 *
 * @param meta         Parsed beatmap metadata including notes
 * @param coverImage   Optional cover image as a Buffer (JPEG/PNG)
 * @param startMs      Map time (ms) at the first frame
 * @param durationMs   How many milliseconds of video to generate
 * @param scrollMs     Visible time window (ms); smaller = faster scroll
 * @param onFrame      Callback with raw RGBA pixel data per frame
 * @param renderOpts   Per-user note style/colour overrides
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
  renderOpts: RenderOptions = {},
): Promise<void> {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  const totalFrames = Math.ceil((durationMs / 1000) * FPS);
  const keys = Math.max(1, meta.keys);
  const colWidth = Math.floor((VIDEO_WIDTH - COL_GAP * (keys + 1)) / keys);

  const noteStyle: NoteStyle = renderOpts.noteStyle ?? NOTE_STYLE_DEFAULT;
  const noteColors: string[] = renderOpts.noteColors ?? NOTE_COLORS_DEFAULT;
  const noteColorSpecial: string =
    renderOpts.noteColorSpecial ?? NOTE_COLOR_SPECIAL_DEFAULT;

  function colX(col: number): number {
    return COL_GAP * (col + 1) + col * colWidth;
  }

  function noteY(noteTimeMs: number, currentMs: number): number {
    const msAhead = noteTimeMs - currentMs;
    const fraction = msAhead / scrollMs; // 0 = at hit line, 1 = top
    return HITLINE_Y - fraction * PLAYFIELD_HEIGHT;
  }

  // Pre-load assets and cover image in parallel
  const [skin, coverLoaded] = await Promise.all([
    loadNoteAssets(),
    (async (): Promise<Image | null> => {
      if (!coverImage) return null;
      try {
        const { loadImage } = await import('@napi-rs/canvas');
        return await loadImage(coverImage);
      } catch {
        return null;
      }
    })(),
  ]);

  const starsText = `${meta.stars.toFixed(2)} ★`;
  const starCol = starColor(meta.stars);

  // Offscreen canvas cache — reused across all frames to avoid per-note native allocations.
  // Note/head/tail sizes are fixed for the whole render (colWidth is constant), so the cache
  // only ever holds a small number of entries (~3 distinct sizes).
  const offscreenCache: OffscreenCache = new Map();

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const currentMs = startMs + (frameIdx / FPS) * 1000;

    // ── Background (cover-cropped) ────────────────────────────────────────────
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    if (coverLoaded) {
      ctx.globalAlpha = 0.18;
      drawCoverFit(ctx, coverLoaded, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
      ctx.globalAlpha = 1;
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

      const color = getNoteColor(
        note.column,
        keys,
        noteColors,
        noteColorSpecial,
      );
      const x = colX(note.column);

      if (note.isHold) {
        const startY = noteY(note.startTime, currentMs);
        const endY = noteY(note.endTime, currentMs);
        const top = Math.min(startY, endY);
        const height = Math.abs(endY - startY);

        // Style-appropriate note head height (notes scroll upward, head is at bottom)
        const headH =
          noteStyle === 'circle'
            ? colWidth
            : noteStyle === 'arrow'
              ? colWidth
              : NOTE_HEIGHT;

        // Hold body — spans from the tail (top of screen) down to the top edge of
        // the head cap, so the body never bleeds into the head asset.
        // Coordinates: endY < startY (tail is higher on screen).
        const bodyTop = Math.max(top, HEADER_HEIGHT); // top = endY (tail)
        const bodyBottom = Math.min(startY - headH / 2, HITLINE_Y); // stop at centre of head
        const bodyH = bodyBottom - bodyTop;
        if (bodyH > 0) {
          drawBodyAsset(
            ctx,
            skin[noteStyle].holdBody,
            color,
            0.4,
            x + 2,
            bodyTop,
            colWidth - 4,
            bodyH,
            offscreenCache,
          );
        }

        // Hold head cap — only while above the hit line
        if (startY >= HEADER_HEIGHT - headH && startY <= HITLINE_Y) {
          drawHoldHeadAsset(
            ctx,
            skin,
            noteStyle,
            x,
            startY,
            colWidth,
            color,
            offscreenCache,
          );
        }

        // Hold tail cap
        if (endY >= HEADER_HEIGHT && endY <= HITLINE_Y) {
          drawHoldTailAsset(
            ctx,
            skin,
            noteStyle,
            x,
            endY,
            colWidth,
            color,
            offscreenCache,
          );
        }
      } else {
        const y = noteY(note.startTime, currentMs);
        const noteH = noteStyle === 'bar' ? NOTE_HEIGHT : colWidth;
        if (y < HEADER_HEIGHT - noteH || y > HITLINE_Y) continue;

        drawNoteAsset(
          ctx,
          skin,
          noteStyle,
          x,
          y,
          colWidth,
          color,
          offscreenCache,
        );
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

    ctx.fillStyle = starCol;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();

    const isLight = meta.stars < 3;
    ctx.fillStyle = isLight ? '#1a1a1a' : '#ffffff';
    ctx.fillText(starsText, badgeX + badgePad, badgeY + 15);

    // ── Extract raw RGBA and emit ─────────────────────────────────────────────
    const imageData = ctx.getImageData(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    const rgbaBuffer = Buffer.from(imageData.data.buffer);
    await onFrame(rgbaBuffer, frameIdx, totalFrames);
  }
}
