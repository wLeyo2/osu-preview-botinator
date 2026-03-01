import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';
import type { SkinMap } from './noteAssets';
import { loadNoteAssets } from './noteAssets';
import type { BeatmapMeta, SvPoint } from './parseBeatmap';
import type { NoteStyle, ScrollDirection } from './userPrefs';
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
/** Downscroll: hit line near the bottom */
const HITLINE_Y_DOWN = VIDEO_HEIGHT - 70;
/** Upscroll: hit line just below the header */
const HITLINE_Y_UP = HEADER_HEIGHT + 10;

const COL_GAP = 2;
const NOTE_HEIGHT = 22;

/** Height of the playfield area (same for both scroll directions) */
const PLAYFIELD_HEIGHT = HITLINE_Y_DOWN - HEADER_HEIGHT;

// ─── SV (Scroll Velocity) helpers ─────────────────────────────────────────────

/**
 * Pre-computed cumulative SV table for fast per-note visual offset lookups.
 * Each entry stores a time boundary and the cumulative SV-weighted ms from
 * `tableStartMs` up to that boundary.
 *
 * This lets us compute the visual offset between any two times in O(log n)
 * via binary search + linear interpolation, instead of O(n) per note per frame.
 */
interface SvTableEntry {
  time: number;
  /** Cumulative SV-weighted ms from tableStartMs to this entry's time. */
  cumulative: number;
  /** SV multiplier active from this entry's time until the next entry. */
  svMultiplier: number;
}

/**
 * Builds a cumulative SV lookup table covering [startMs, endMs].
 *
 * For maps with no SV points, returns a single entry with svMultiplier=1.0
 * so the renderer behaves identically to the pre-SV code path.
 */
function buildSvTable(
  svPoints: SvPoint[],
  startMs: number,
  endMs: number,
): SvTableEntry[] {
  // Determine active SV at each boundary within [startMs, endMs]
  const boundaries: { time: number; svMultiplier: number }[] = [];

  // Find the SV in effect at startMs
  let initialSv = 1.0;
  for (let i = svPoints.length - 1; i >= 0; i--) {
    if ((svPoints[i]?.time ?? 0) <= startMs) {
      initialSv = svPoints[i]?.svMultiplier ?? 1.0;
      break;
    }
  }
  boundaries.push({ time: startMs, svMultiplier: initialSv });

  // Add all SV change boundaries within (startMs, endMs)
  for (const pt of svPoints) {
    if (pt.time > startMs && pt.time < endMs) {
      boundaries.push({ time: pt.time, svMultiplier: pt.svMultiplier });
    }
  }
  boundaries.push({
    time: endMs,
    svMultiplier: boundaries[boundaries.length - 1]?.svMultiplier ?? 1.0,
  });

  // Build cumulative table
  const table: SvTableEntry[] = [];
  let cumulative = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const cur = boundaries[i]!;
    const next = boundaries[i + 1]!;
    table.push({ time: cur.time, cumulative, svMultiplier: cur.svMultiplier });
    cumulative += (next.time - cur.time) * cur.svMultiplier;
  }
  // Final boundary entry
  table.push({
    time: endMs,
    cumulative,
    svMultiplier: boundaries[boundaries.length - 1]?.svMultiplier ?? 1.0,
  });

  return table;
}

/**
 * Returns the SV-weighted visual distance (in ms-equivalent units) between
 * `fromMs` and `toMs`, using the pre-built SV table.
 *
 * Positive result = toMs is after fromMs.
 * Can handle toMs < fromMs (returns negative value) for tail notes below head.
 */
function svVisualOffset(
  table: SvTableEntry[],
  fromMs: number,
  toMs: number,
): number {
  if (table.length === 0) return toMs - fromMs;

  const sign = toMs >= fromMs ? 1 : -1;
  const lo = sign > 0 ? fromMs : toMs;
  const hi = sign > 0 ? toMs : fromMs;

  // Find the table segment containing lo
  let loIdx = 0;
  for (let i = table.length - 1; i >= 0; i--) {
    if ((table[i]?.time ?? 0) <= lo) {
      loIdx = i;
      break;
    }
  }
  // Find the table segment containing hi
  let hiIdx = table.length - 1;
  for (let i = table.length - 1; i >= 0; i--) {
    if ((table[i]?.time ?? 0) <= hi) {
      hiIdx = i;
      break;
    }
  }

  if (loIdx === hiIdx) {
    // Both within the same segment — simple multiplication
    return sign * (hi - lo) * (table[loIdx]?.svMultiplier ?? 1.0);
  }

  // Sum across segments
  const loEntry = table[loIdx]!;
  const loNextEntry = table[loIdx + 1]!;
  let total = (loNextEntry.time - lo) * loEntry.svMultiplier;

  for (let i = loIdx + 1; i < hiIdx; i++) {
    const entry = table[i]!;
    const nextEntry = table[i + 1]!;
    total += (nextEntry.time - entry.time) * entry.svMultiplier;
  }

  const hiEntry = table[hiIdx]!;
  total += (hi - hiEntry.time) * hiEntry.svMultiplier;

  return sign * total;
}

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
  scrollDirection?: ScrollDirection;
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
  const scrollDirection: ScrollDirection = renderOpts.scrollDirection ?? 'down';

  // Direction-dependent layout values
  const hitLineY = scrollDirection === 'up' ? HITLINE_Y_UP : HITLINE_Y_DOWN;
  // For downscroll: notes enter from the top (low Y) and travel to hitLineY at bottom.
  // For upscroll:   notes enter from the bottom (high Y) and travel to hitLineY near top.
  const noteEntryY =
    scrollDirection === 'up' ? VIDEO_HEIGHT - 70 : HEADER_HEIGHT;

  function colX(col: number): number {
    return COL_GAP * (col + 1) + col * colWidth;
  }

  /**
   * Converts a note's map time to a canvas Y coordinate.
   *
   * With SV: uses the SV-weighted visual offset so sections with SV>1 appear
   * further apart (faster) and SV<1 appear compressed (slower).
   *
   * Without SV (or standard maps): degrades to simple linear interpolation,
   * identical to previous behaviour.
   *
   * Downscroll: hit line at bottom (HITLINE_Y_DOWN). Notes approaching have
   *   larger msAhead → placed higher (smaller Y).
   * Upscroll: hit line at top (HITLINE_Y_UP). Notes approaching have larger
   *   msAhead → placed lower (larger Y).
   */
  function noteY(noteTimeMs: number, currentMs: number): number {
    const visualMs = svVisualOffset(svTable, currentMs, noteTimeMs);
    const fraction = visualMs / scrollMs; // 0=at hit line, positive=approaching
    if (scrollDirection === 'up') {
      // Notes below the hit line, moving upward
      return hitLineY + fraction * PLAYFIELD_HEIGHT;
    }
    // Downscroll: notes above the hit line, moving downward
    return hitLineY - fraction * PLAYFIELD_HEIGHT;
  }

  // Build the SV lookup table once for the full render window.
  // For standard maps or maps with no SV points this is a trivial 1-entry table.
  const svTable = buildSvTable(meta.svPoints, startMs, startMs + durationMs);

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

        // "Head" = the end closest to the hit line.
        // Downscroll: startTime is the head (larger Y = closer to bottom hit line).
        // Upscroll:   startTime is the head (smaller Y = closer to top hit line).
        const headY = startY;
        const tailY = endY;

        const top = Math.min(headY, tailY);
        const height = Math.abs(headY - tailY);

        // Style-appropriate note head height
        const headH =
          noteStyle === 'circle'
            ? colWidth
            : noteStyle === 'arrow'
              ? colWidth
              : NOTE_HEIGHT;

        // Hold body — spans between tail and the centre of the head cap.
        let bodyTop: number;
        let bodyBottom: number;
        if (scrollDirection === 'up') {
          // Upscroll: head is at the top (smaller Y), tail is below (larger Y).
          // Body runs from just below the head centre down to the tail.
          bodyTop = Math.max(headY - headH / 2, HEADER_HEIGHT);
          bodyBottom = Math.min(tailY, noteEntryY);
        } else {
          // Downscroll: head is at the bottom (larger Y), tail is above (smaller Y).
          // Body runs from the tail down to just above the head centre.
          bodyTop = Math.max(tailY, HEADER_HEIGHT);
          bodyBottom = Math.min(headY - headH / 2, hitLineY);
        }
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

        // Hold head cap
        const headVisible =
          scrollDirection === 'up'
            ? headY >= HEADER_HEIGHT && headY <= noteEntryY + headH
            : headY >= HEADER_HEIGHT - headH && headY <= hitLineY;
        if (headVisible) {
          drawHoldHeadAsset(
            ctx,
            skin,
            noteStyle,
            x,
            headY,
            colWidth,
            color,
            offscreenCache,
          );
        }

        // Hold tail cap
        const tailVisible =
          scrollDirection === 'up'
            ? tailY >= HEADER_HEIGHT && tailY <= noteEntryY
            : tailY >= HEADER_HEIGHT && tailY <= hitLineY;
        if (tailVisible) {
          drawHoldTailAsset(
            ctx,
            skin,
            noteStyle,
            x,
            tailY,
            colWidth,
            color,
            offscreenCache,
          );
        }
      } else {
        const y = noteY(note.startTime, currentMs);
        const noteH = noteStyle === 'bar' ? NOTE_HEIGHT : colWidth;
        const outOfBounds =
          scrollDirection === 'up'
            ? y < HEADER_HEIGHT || y > noteEntryY + noteH
            : y < HEADER_HEIGHT - noteH || y > hitLineY;
        if (outOfBounds) continue;

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
    ctx.fillRect(0, hitLineY - 8, VIDEO_WIDTH, 16);
    ctx.fillStyle = HITLINE_COLOR;
    ctx.fillRect(0, hitLineY - 1, VIDEO_WIDTH, 2);

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
