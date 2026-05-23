import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Image } from '@napi-rs/canvas';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SvPoint } from '@/utils/osu/parseBeatmap';
import type { ScrollDirection } from '@/utils/osu/userPrefs';
import {
  buildColumnsLayer,
  buildHeaderLayer,
  buildHitLineLayer,
  COL_GAP,
  HEADER_H,
  PLAYFIELD_H,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
} from './layers';
import {
  drawTintedAsset,
  drawTintedAssetClipped,
  type TintedAssetCache,
} from './tintedCache';
import type { NoteStyle, RenderContext } from './types';

// ─── Note skin loading ───

interface NoteSkin {
  note: Image;
  holdHead: Image;
  holdTail: Image;
  holdBody: Image;
}

async function loadSkin(style: NoteStyle): Promise<NoteSkin> {
  const dir = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'assets',
    'notes',
    style,
  );
  const [note, holdHead, holdTail, holdBody] = await Promise.all([
    loadImage(readFileSync(join(dir, 'note.png'))),
    loadImage(readFileSync(join(dir, 'hold-head.png'))),
    loadImage(readFileSync(join(dir, 'hold-tail.png'))),
    loadImage(readFileSync(join(dir, 'hold-body.png'))),
  ]);
  return { note, holdHead, holdTail, holdBody };
}

let _cachedSkins: Partial<Record<NoteSkinKey, NoteSkin>> | null = null;
async function getSkin(style: NoteStyle): Promise<NoteSkin> {
  if (!_cachedSkins) {
    const [bar, circle, arrow] = await Promise.all([
      loadSkin('bar'),
      loadSkin('circle'),
      loadSkin('arrow'),
    ]);
    _cachedSkins = { bar, circle, arrow };
  }
  if (_cachedSkins[style]) return _cachedSkins[style];
  if (_cachedSkins.bar) return _cachedSkins.bar;
  // Fallback: circle is always present after initialization
  for (const key of ['circle', 'arrow'] as const) {
    const fallback = _cachedSkins[key];
    if (fallback) return fallback;
  }
  // Should never reach here, but TS needs a return
  return _cachedSkins.circle as NoteSkin;
}

type NoteSkinKey = 'bar' | 'circle' | 'arrow';

// ─── Layout constants (proportional to canvas size) ───

const NOTE_H = Math.round(VIDEO_HEIGHT * 0.034);
const FOOTER_H = Math.round(VIDEO_HEIGHT * 0.069);
const FOOTER_PAD_X = Math.round(VIDEO_WIDTH * 0.033);
const FOOTER_PAD_Y = Math.round(VIDEO_HEIGHT * 0.013);
const BG_COLOR = '#0d0d0d';

// ─── SV table ───

interface SvEntry {
  time: number;
  cumulative: number;
  sv: number;
}

function buildSvTable(
  svPoints: SvPoint[],
  startMs: number,
  endMs: number,
): SvEntry[] {
  const bounds: { time: number; sv: number }[] = [];
  let initialSv = 1.0;
  for (let i = svPoints.length - 1; i >= 0; i--) {
    if ((svPoints[i]?.time ?? 0) <= startMs) {
      initialSv = svPoints[i]?.svMultiplier ?? 1.0;
      break;
    }
  }
  bounds.push({ time: startMs, sv: initialSv });
  for (const pt of svPoints) {
    if (pt.time > startMs && pt.time < endMs)
      bounds.push({ time: pt.time, sv: pt.svMultiplier });
  }
  bounds.push({ time: endMs, sv: bounds[bounds.length - 1]?.sv ?? 1.0 });

  const table: SvEntry[] = [];
  let cumulative = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const cur = bounds[i];
    const next = bounds[i + 1];
    if (!cur || !next) continue;
    table.push({ time: cur.time, cumulative, sv: cur.sv });
    cumulative += (next.time - cur.time) * cur.sv;
  }
  table.push({
    time: endMs,
    cumulative,
    sv: bounds[bounds.length - 1]?.sv ?? 1.0,
  });
  return table;
}

function svAt(table: SvEntry[], timeMs: number): number {
  if (table.length === 0) return timeMs;
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) return timeMs;
  if (timeMs <= first.time)
    return first.cumulative + (timeMs - first.time) * first.sv;
  if (timeMs >= last.time)
    return last.cumulative + (timeMs - last.time) * last.sv;
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((table[mid]?.time ?? 0) <= timeMs) lo = mid + 1;
    else hi = mid - 1;
  }
  const entry = table[Math.max(0, Math.min(table.length - 1, hi))];
  if (!entry) return timeMs;
  return entry.cumulative + (timeMs - entry.time) * entry.sv;
}

// ─── Strain footer ───

interface StrainOverlay {
  canvas: import('@napi-rs/canvas').Canvas;
  plotX: number;
  plotY: number;
  plotH: number;
  profileY: Float32Array;
}

function buildStrainOverlay(
  strainValues: Float64Array,
  strainSectionMs: number,
  strainStartMs: number,
  startMs: number,
  durationMs: number,
): StrainOverlay | null {
  if (strainValues.length === 0 || durationMs <= 0) return null;
  const plotX = FOOTER_PAD_X;
  const plotY = FOOTER_PAD_Y + 8;
  const plotW = VIDEO_WIDTH - FOOTER_PAD_X * 2;
  const plotH = FOOTER_H - plotY - FOOTER_PAD_Y;
  if (plotW < 2 || plotH < 4) return null;

  const sectionMs = Math.max(1, strainSectionMs);
  const sampled = new Float32Array(plotW);
  let maxVal = 0;
  for (let x = 0; x < plotW; x++) {
    const frac = x / (plotW - 1);
    const timeMs = startMs + frac * durationMs;
    const idx = Math.max(
      0,
      Math.min(
        strainValues.length - 1,
        Math.floor((timeMs - strainStartMs) / sectionMs),
      ),
    );
    const v = strainValues[idx] ?? 0;
    sampled[x] = v;
    if (v > maxVal) maxVal = v;
  }

  const norm = maxVal > 0 ? maxVal : 1;
  const profileY = new Float32Array(plotW);
  const baseY = plotY + plotH;
  const footerCanvas = createCanvas(VIDEO_WIDTH, FOOTER_H);
  const fCtx = footerCanvas.getContext('2d');

  fCtx.fillStyle = 'rgba(0,0,0,0.42)';
  fCtx.fillRect(0, 0, VIDEO_WIDTH, FOOTER_H);
  fCtx.fillStyle = 'rgba(255,255,255,0.4)';
  fCtx.font = `${Math.max(8, Math.round(FOOTER_H * 0.23))}px sans-serif`;
  fCtx.fillText('strain', plotX, FOOTER_PAD_Y + Math.round(FOOTER_H * 0.16));
  fCtx.fillStyle = 'rgba(255,255,255,0.08)';
  fCtx.fillRect(plotX, baseY, plotW, 1);

  fCtx.beginPath();
  fCtx.moveTo(plotX, baseY);
  for (let x = 0; x < plotW; x++) {
    const y = baseY - ((sampled[x] ?? 0) / norm) * plotH;
    profileY[x] = y;
    fCtx.lineTo(plotX + x, y);
  }
  fCtx.lineTo(plotX + plotW - 1, baseY);
  fCtx.closePath();
  fCtx.fillStyle = 'rgba(84,180,250,0.22)';
  fCtx.fill();

  fCtx.beginPath();
  for (let x = 0; x < plotW; x++) {
    const y = profileY[x] ?? baseY;
    x === 0 ? fCtx.moveTo(plotX, y) : fCtx.lineTo(plotX + x, y);
  }
  fCtx.strokeStyle = 'rgba(166,226,255,0.78)';
  fCtx.lineWidth = 1.25;
  fCtx.stroke();

  return { canvas: footerCanvas, plotX, plotY, plotH, profileY };
}

function drawStrainFrame(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
  overlay: StrainOverlay,
  currentMs: number,
  startMs: number,
  durationMs: number,
): void {
  const footerY = VIDEO_HEIGHT - FOOTER_H;
  ctx.drawImage(overlay.canvas, 0, footerY);
  const progress = Math.max(
    0,
    Math.min(1, (currentMs - startMs) / Math.max(1, durationMs)),
  );
  const idx = Math.max(
    0,
    Math.min(
      overlay.profileY.length - 1,
      Math.round(progress * (overlay.profileY.length - 1)),
    ),
  );
  const px = overlay.plotX + idx;
  const py = overlay.profileY[idx] ?? overlay.plotY + overlay.plotH;
  ctx.strokeStyle = 'rgba(255,255,255,0.74)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 0.5, footerY + overlay.plotY - 1);
  ctx.lineTo(px + 0.5, footerY + overlay.plotY + overlay.plotH + 1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.arc(px, footerY + py, 2, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Note draw rect ───

function noteDrawRect(
  style: NoteStyle,
  x: number,
  bottomY: number,
  colWidth: number,
) {
  if (style === 'circle' || style === 'arrow')
    return { x, topY: bottomY - colWidth, w: colWidth, h: colWidth };
  return { x, topY: bottomY - NOTE_H, w: colWidth, h: NOTE_H };
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

// ─── Mania renderer ───

export async function renderManiaFrames(
  ctx: RenderContext,
  onFrame: (buffer: Buffer, frameIdx: number, total: number) => Promise<void>,
): Promise<void> {
  const { meta, startMs, durationMs, scrollMs, fps, opts } = ctx;
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const c = canvas.getContext('2d');

  const totalFrames = Math.ceil((durationMs / 1000) * fps);
  const keys = Math.max(1, meta.keys);
  const colWidth = Math.floor((VIDEO_WIDTH - COL_GAP * (keys + 1)) / keys);
  const style: NoteStyle = opts.noteStyle ?? 'bar';
  const noteColors = opts.noteColors ?? [
    '#00aaff',
    '#ffffff',
    '#00aaff',
    '#ffffff',
  ];
  const noteColorSpecial = opts.noteColorSpecial ?? '#ffdd00';
  const scrollDirection: ScrollDirection = opts.scrollDirection ?? 'down';
  const strainEnabled = opts.strainOverlay ?? true;
  const noteCapH = style === 'bar' ? NOTE_H : colWidth;

  // Direction-dependent layout
  const hitLineY =
    scrollDirection === 'up'
      ? HEADER_H + 10
      : VIDEO_HEIGHT - Math.round(VIDEO_HEIGHT * 0.109);
  const _entryY = scrollDirection === 'up' ? VIDEO_HEIGHT - 70 : HEADER_H;

  const colX = (col: number) => COL_GAP * (col + 1) + col * colWidth;

  // Convert note visual ms to canvas Y
  const noteToY = (visualMs: number, currentVisualMs: number): number => {
    const fraction = (visualMs - currentVisualMs) / scrollMs;
    if (scrollDirection === 'up') return hitLineY + fraction * PLAYFIELD_H;
    return hitLineY - fraction * PLAYFIELD_H;
  };

  // SV table
  const svTable = buildSvTable(meta.svPoints, startMs, startMs + durationMs);

  // Pre-compute note data
  const noteCount = meta.notes.length;
  const noteXArr = new Float64Array(noteCount);
  const noteStartVis = new Float64Array(noteCount);
  const noteEndVis = new Float64Array(noteCount);
  const noteColorArr: string[] = new Array(noteCount);

  for (let i = 0; i < noteCount; i++) {
    const note = meta.notes[i];
    if (!note) continue;
    noteXArr[i] = colX(note.column);
    noteColorArr[i] = getNoteColor(
      note.column,
      keys,
      noteColors,
      noteColorSpecial,
    );
    noteStartVis[i] = svAt(svTable, note.startTime);
    noteEndVis[i] = svAt(svTable, note.endTime);
  }

  // Load assets
  const skin = await getSkin(style);

  // Pre-render static layers
  const headerLayer = buildHeaderLayer({
    artist: meta.artist,
    title: meta.title,
    version: meta.version,
    keys,
    creator: meta.creator,
    stars: meta.stars,
  });
  const columnsLayer = buildColumnsLayer(keys, colWidth);
  const hitLineLayer = buildHitLineLayer(hitLineY);
  const strainOverlay = strainEnabled
    ? buildStrainOverlay(
        meta.strainValues,
        meta.strainSectionMs,
        meta.strainStartMs,
        startMs,
        durationMs,
      )
    : null;

  // Pre-render background (solid dark, no cover for performance)
  const bgCanvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const bgCtx = bgCanvas.getContext('2d');
  bgCtx.fillStyle = BG_COLOR;
  bgCtx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  const tintedCache: TintedAssetCache = new Map();
  const visibleTop = HEADER_H - noteCapH;
  const visibleBottom =
    scrollDirection === 'up' ? VIDEO_HEIGHT - 70 + noteCapH : hitLineY;

  // Ring buffer for frame pixel data
  const ringSize = 3;
  const ring = Array.from({ length: ringSize }, () =>
    Buffer.allocUnsafe(VIDEO_WIDTH * VIDEO_HEIGHT * 4),
  );
  let ringIdx = 0;

  let activeStart = 0;
  let activeEnd = 0;

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const currentMs = startMs + (frameIdx / fps) * 1000;
    const currentVis = svAt(svTable, currentMs);

    // Background (pre-rendered dark fill)
    c.drawImage(bgCanvas, 0, 0);

    // Columns (pre-rendered)
    c.drawImage(columnsLayer, 0, HEADER_H);

    // Notes
    const winStart = currentMs - 200;
    const winEnd = currentMs + scrollMs + 200;

    while (activeStart < noteCount) {
      const n = meta.notes[activeStart];
      if (!n || n.endTime >= winStart) break;
      activeStart++;
    }
    if (activeEnd < activeStart) activeEnd = activeStart;
    while (activeEnd < noteCount) {
      const n = meta.notes[activeEnd];
      if (!n || n.startTime > winEnd) break;
      activeEnd++;
    }

    for (let i = activeStart; i < activeEnd; i++) {
      const note = meta.notes[i];
      if (!note || note.endTime < winStart) continue;

      const color = noteColorArr[i] ?? '#ffffff';
      const x = noteXArr[i] ?? 0;

      if (note.isHold) {
        const startY = noteToY(noteStartVis[i] ?? 0, currentVis);
        const endY = noteToY(noteEndVis[i] ?? 0, currentVis);
        const headY = scrollDirection === 'up' ? endY : startY;
        const tailY = scrollDirection === 'up' ? startY : endY;

        let bodyTop: number;
        let bodyBottom: number;
        if (scrollDirection === 'up') {
          bodyTop = Math.max(tailY, HEADER_H);
          bodyBottom = Math.min(headY + noteCapH / 2, hitLineY + PLAYFIELD_H);
        } else {
          bodyTop = Math.max(tailY, HEADER_H);
          bodyBottom = Math.min(headY - noteCapH / 2, hitLineY);
        }
        const bodyH = bodyBottom - bodyTop;

        if (bodyH > 0) {
          drawTintedAssetClipped(
            c,
            tintedCache,
            skin.holdBody,
            `${style}:hold-body`,
            color,
            0.4,
            x + 2,
            bodyTop,
            colWidth - 4,
            bodyH,
            PLAYFIELD_H,
          );
        }

        const headVisible =
          scrollDirection === 'up'
            ? headY >= HEADER_H - noteCapH && headY <= VIDEO_HEIGHT - 70
            : headY >= visibleTop && headY <= visibleBottom;
        if (headVisible) {
          const { x: dx, topY, w, h } = noteDrawRect(style, x, headY, colWidth);
          drawTintedAsset(
            c,
            tintedCache,
            skin.holdHead,
            `${style}:hold-head`,
            color,
            1,
            dx,
            topY,
            w,
            h,
          );
        }

        const tailVisible =
          scrollDirection === 'up'
            ? tailY >= HEADER_H && tailY <= VIDEO_HEIGHT - 70
            : tailY >= HEADER_H && tailY <= hitLineY;
        if (tailVisible) {
          drawTintedAsset(
            c,
            tintedCache,
            skin.holdTail,
            `${style}:hold-tail`,
            color,
            0.85,
            x,
            tailY - 4,
            colWidth,
            8,
          );
        }
      } else {
        const y = noteToY(noteStartVis[i] ?? 0, currentVis);
        if (y < visibleTop || y > visibleBottom) continue;
        const { x: dx, topY, w, h } = noteDrawRect(style, x, y, colWidth);
        drawTintedAsset(
          c,
          tintedCache,
          skin.note,
          `${style}:note`,
          color,
          1,
          dx,
          topY,
          w,
          h,
        );
      }
    }

    // Hit line (pre-rendered)
    c.drawImage(hitLineLayer, 0, hitLineY - Math.round(VIDEO_HEIGHT * 0.013));

    // Strain footer
    if (strainOverlay)
      drawStrainFrame(c, strainOverlay, currentMs, startMs, durationMs);

    // Header (pre-rendered)
    c.drawImage(headerLayer.canvas, 0, 0);

    // Extract pixels via ring buffer
    const pixelData = (canvas as unknown as { data: () => Buffer }).data();
    const ringBuffer = ring[ringIdx % ringSize];
    if (ringBuffer) {
      pixelData.copy(ringBuffer);
    }
    ringIdx++;
    await onFrame(ringBuffer ?? pixelData, frameIdx, totalFrames);
  }
}
