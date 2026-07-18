import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Image } from '@napi-rs/canvas';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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
import { buildStrainOverlay, drawStrainCursor } from './strain';
import { buildSvTable, svAt } from './svtable';
import {
  drawTintedAsset,
  drawTintedAssetClipped,
  type TintedAssetCache,
} from './tintedCache';
import type { NoteStyle, RenderContext, Renderer } from './types';

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

let _cachedSkins: Partial<Record<NoteStyle, NoteSkin>> | null = null;
async function getSkin(style: NoteStyle): Promise<NoteSkin> {
  if (!_cachedSkins) {
    const [bar, circle, arrow] = await Promise.all([
      loadSkin('bar'),
      loadSkin('circle'),
      loadSkin('arrow'),
    ]);
    _cachedSkins = { bar, circle, arrow };
  }
  const skin = _cachedSkins[style] ?? _cachedSkins.bar;
  if (!skin) throw new Error(`Note skin not found: ${style}`);
  return skin;
}

// ─── Layout constants (proportional to canvas size) ───

const NOTE_H = Math.round(VIDEO_HEIGHT * 0.034);
const FOOTER_H = Math.round(VIDEO_HEIGHT * 0.069);
const FOOTER_PAD_X = Math.round(VIDEO_WIDTH * 0.033);
const FOOTER_PAD_Y = Math.round(VIDEO_HEIGHT * 0.013);
const BG_COLOR = '#0d0d0d';

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

// osu!stable's per-keymode colour layout: columns alternate primary/accent
// from the outer edge inward, mirrored, with the special colour on the centre
// column of odd keymodes (4K → 1221, 5K → 12S21, 7K → 121S121, 9K → 1212S2121).
function buildColumnColors(
  keys: number,
  noteColors: string[],
  noteColorSpecial: string,
): string[] {
  const primary = noteColors[0] ?? '#ffffff';
  const accent = noteColors[1] ?? '#00aaff';
  const half: string[] = [];
  for (let i = 0; i < Math.floor(keys / 2); i++)
    half.push(i % 2 === 0 ? primary : accent);
  const mirrored = [...half].reverse();
  return keys % 2 === 1
    ? [...half, noteColorSpecial, ...mirrored]
    : [...half, ...mirrored];
}

// ─── Mania renderer ───

export class ManiaRenderer implements Renderer {
  readonly gamemode = 'mania';
  readonly width = VIDEO_WIDTH;
  readonly height = VIDEO_HEIGHT;

  async renderFrames(
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
    const noteColors = opts.noteColors ?? ['#ffffff', '#00aaff'];
    const noteColorSpecial = opts.noteColorSpecial ?? '#ffdd00';
    const scrollDirection: ScrollDirection = opts.scrollDirection ?? 'down';
    const strainEnabled = opts.strainOverlay ?? true;
    const noteCapH = style === 'bar' ? NOTE_H : colWidth;

    // Direction-dependent layout
    const hitLineY =
      scrollDirection === 'up'
        ? HEADER_H + 10
        : VIDEO_HEIGHT - Math.round(VIDEO_HEIGHT * 0.109);

    const colX = (col: number) => COL_GAP * (col + 1) + col * colWidth;

    const noteToY = (visualMs: number, currentVisualMs: number): number => {
      const fraction = (visualMs - currentVisualMs) / scrollMs;
      if (scrollDirection === 'up') return hitLineY + fraction * PLAYFIELD_H;
      return hitLineY - fraction * PLAYFIELD_H;
    };

    const svTable = buildSvTable(
      meta.svPoints.map((p) => ({ time: p.time, multiplier: p.svMultiplier })),
      startMs,
      startMs + durationMs,
    );

    // Pre-compute note data
    const noteCount = meta.notes.length;
    const noteXArr = new Float64Array(noteCount);
    const noteStartVis = new Float64Array(noteCount);
    const noteEndVis = new Float64Array(noteCount);
    const noteColorArr: string[] = new Array(noteCount);

    const columnColors = buildColumnColors(keys, noteColors, noteColorSpecial);

    for (let i = 0; i < noteCount; i++) {
      const note = meta.notes[i];
      if (!note) continue;
      noteXArr[i] = colX(note.column);
      noteColorArr[i] = columnColors[note.column] ?? '#ffffff';
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
          {
            width: VIDEO_WIDTH,
            footerH: FOOTER_H,
            padX: FOOTER_PAD_X,
            padY: FOOTER_PAD_Y,
          },
        )
      : null;

    // Pre-render background with all static layers baked in: dark fill,
    // column separators, and the strain footer (its cursor is per-frame).
    const bgCanvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.fillStyle = BG_COLOR;
    bgCtx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    bgCtx.drawImage(columnsLayer, 0, HEADER_H);
    if (strainOverlay)
      bgCtx.drawImage(strainOverlay.canvas, 0, VIDEO_HEIGHT - FOOTER_H);

    const tintedCache: TintedAssetCache = new Map();
    const visibleTop = HEADER_H - noteCapH;
    const visibleBottom =
      scrollDirection === 'up' ? VIDEO_HEIGHT - 70 + noteCapH : hitLineY;

    let activeStart = 0;
    let activeEnd = 0;

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const currentMs = startMs + (frameIdx / fps) * 1000;
      const currentVis = svAt(svTable, currentMs);

      // Background (pre-rendered: dark fill + columns + strain footer)
      c.drawImage(bgCanvas, 0, 0);

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
            const {
              x: dx,
              topY,
              w,
              h,
            } = noteDrawRect(style, x, headY, colWidth);
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

      // Strain footer cursor (footer itself is baked into the background)
      if (strainOverlay)
        drawStrainCursor(
          c,
          strainOverlay,
          currentMs,
          startMs,
          durationMs,
          VIDEO_HEIGHT - FOOTER_H,
        );

      // Header (pre-rendered)
      c.drawImage(headerLayer.canvas, 0, 0);

      // canvas.data() is a view over the live surface; the encoder copies it
      // before queueing, so it must not be retained across frames here.
      await onFrame(canvas.data(), frameIdx, totalFrames);
    }
  }
}
