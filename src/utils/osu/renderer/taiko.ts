import { type Canvas, createCanvas } from '@napi-rs/canvas';
import type { BeatmapMeta } from '@/utils/osu/parseBeatmap';
import { roundRect, starColor, VIDEO_HEIGHT, VIDEO_WIDTH } from './layers';
import { buildStrainOverlay, drawStrainCursor } from './strain';
import { buildSvTable, svAt, type VelocityPoint } from './svtable';
import type { RenderContext, Renderer } from './types';

// ─── Landscape layout (taiko scrolls horizontally) ───

const TW = Math.max(VIDEO_WIDTH, VIDEO_HEIGHT);
const TH = Math.min(VIDEO_WIDTH, VIDEO_HEIGHT);
const HEADER_H = Math.round(TH * 0.17);
const FOOTER_H = Math.round(TH * 0.11);
const FOOTER_PAD_X = Math.round(TW * 0.033);
const FOOTER_PAD_Y = Math.max(2, Math.round(TH * 0.013));
const LANE_TOP = HEADER_H;
const LANE_BOTTOM = TH - FOOTER_H;
const LANE_H = LANE_BOTTOM - LANE_TOP;
const LANE_CY = LANE_TOP + LANE_H / 2;
const DRUM_CX = Math.round(TW * 0.085);
const DRUM_R = Math.round(LANE_H * 0.22);
// Playfield starts right of the drum; notes and barlines clip against it
const PLAYFIELD_LEFT = DRUM_CX + DRUM_R + 4;
const HIT_X = Math.round(TW * 0.32);
const TRAVEL_W = TW - HIT_X;
const R_SMALL = Math.round(LANE_H * 0.155);
const R_BIG = Math.round(LANE_H * 0.23);
// How long a drum input stays lit after a hit
const FLASH_MS = 120;

const COLOR_DON = '#e8442e';
const COLOR_KAT = '#3fa7dd';
const COLOR_ROLL = '#f2b125';
const COLOR_SWELL = '#ff9838';

// ─── Sprites ───

function buildNoteSprite(color: string, r: number): Canvas {
  const size = r * 2 + 4;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;

  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  const ringW = Math.max(2, r * 0.14);
  ctx.beginPath();
  ctx.arc(cx, cx, r - ringW / 2 - 1, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = ringW;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cx, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  return canvas;
}

// ─── Autoplay drum (left side, reacts to notes) ───

function buildDrumBaseSprite(): Canvas {
  const size = DRUM_R * 2 + 6;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;

  ctx.beginPath();
  ctx.arc(cx, cx, DRUM_R, 0, Math.PI * 2);
  ctx.fillStyle = '#262020';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner face boundary (don area vs kat rim)
  ctx.beginPath();
  ctx.arc(cx, cx, DRUM_R * 0.62, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Left/right hand split
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(cx - 0.5, cx - DRUM_R, 1, DRUM_R * 2);

  return canvas;
}

interface DrumFlashSprites {
  innerLeft: Canvas;
  innerRight: Canvas;
  outerLeft: Canvas;
  outerRight: Canvas;
}

/** Half-disc (inner/don) or half-ring (outer/kat) highlight for one hand */
function buildDrumFlashSprite(isKat: boolean, isLeft: boolean): Canvas {
  const size = DRUM_R * 2 + 6;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const from = isLeft ? Math.PI / 2 : -Math.PI / 2;
  const to = isLeft ? (3 * Math.PI) / 2 : Math.PI / 2;

  ctx.beginPath();
  if (isKat) {
    ctx.arc(cx, cx, DRUM_R * 0.96, from, to);
    ctx.arc(cx, cx, DRUM_R * 0.68, to, from, true);
  } else {
    ctx.arc(cx, cx, DRUM_R * 0.58, from, to);
  }
  ctx.closePath();
  ctx.fillStyle = isKat ? COLOR_KAT : COLOR_DON;
  ctx.fill();

  return canvas;
}

function buildDrumFlashSprites(): DrumFlashSprites {
  return {
    innerLeft: buildDrumFlashSprite(false, true),
    innerRight: buildDrumFlashSprite(false, false),
    outerLeft: buildDrumFlashSprite(true, true),
    outerRight: buildDrumFlashSprite(true, false),
  };
}

// Soft filled disc, deliberately unlike the drum's hard rings, so the
// place where notes are hit isn't mistaken for the autoplay drum
function buildHitTargetSprite(): Canvas {
  const r = R_BIG + 3;
  const size = r * 2 + 6;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;

  const gradient = ctx.createRadialGradient(cx, cx, r * 0.2, cx, cx, r);
  gradient.addColorStop(0, 'rgba(255,255,255,0.14)');
  gradient.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  return canvas;
}

/** Colored flash at the hit target when a note arrives */
function buildHitBurstSprite(rgb: string): Canvas {
  const r = Math.round(R_BIG * 1.3);
  const size = r * 2 + 4;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;

  const gradient = ctx.createRadialGradient(cx, cx, r * 0.15, cx, cx, r);
  gradient.addColorStop(0, `rgba(${rgb},0.55)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  return canvas;
}

// ─── Static base layer (bg + lane + header + strain footer) ───

function buildBaseLayer(
  meta: BeatmapMeta,
  strainOverlay: { canvas: Canvas } | null,
): Canvas {
  const canvas = createCanvas(TW, TH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, TW, TH);

  // Lane band
  const bandH = LANE_H * 0.72;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, LANE_CY - bandH / 2, TW, bandH);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, LANE_CY - bandH / 2, TW, 1);
  ctx.fillRect(0, LANE_CY + bandH / 2 - 1, TW, 1);

  // Drum area, separated from the playfield
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, LANE_TOP, PLAYFIELD_LEFT - 1, LANE_H);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(PLAYFIELD_LEFT - 1, LANE_TOP, 1, LANE_H);

  // Header
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(0, 0, TW, HEADER_H);
  const padX = Math.round(TW * 0.025);
  const titleSize = Math.round(HEADER_H * 0.38);
  const subSize = Math.round(HEADER_H * 0.3);

  const starsText = `${meta.stars.toFixed(2)} ★`;
  const badgeSize = Math.round(HEADER_H * 0.32);
  ctx.font = `bold ${badgeSize}px sans-serif`;
  const starTextW = ctx.measureText(starsText).width;
  const badgePad = Math.round(HEADER_H * 0.14);
  const badgeH = Math.round(HEADER_H * 0.5);
  const badgeW = starTextW + badgePad * 2;
  const badgeX = TW - badgeW - padX;
  const badgeY = HEADER_H / 2 - badgeH / 2;
  const textMaxW = badgeX - padX * 2;

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillText(
    `${meta.artist} - ${meta.title}`,
    padX,
    HEADER_H * 0.4,
    textMaxW,
  );
  ctx.fillStyle = '#aaaaaa';
  ctx.font = `${subSize}px sans-serif`;
  ctx.fillText(
    `[${meta.version}]  •  ${Math.round(meta.bpm)} BPM  •  mapped by ${meta.creator}`,
    padX,
    HEADER_H * 0.78,
    textMaxW,
  );

  ctx.fillStyle = starColor(meta.stars);
  roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.fillStyle = meta.stars < 3 ? '#1a1a1a' : '#ffffff';
  ctx.font = `bold ${badgeSize}px sans-serif`;
  ctx.fillText(starsText, badgeX + badgePad, badgeY + badgeH * 0.72);

  if (strainOverlay) ctx.drawImage(strainOverlay.canvas, 0, TH - FOOTER_H);

  return canvas;
}

// ─── Scroll velocity (BPM changes and SV both move taiko notes) ───

function buildVelocityPoints(meta: BeatmapMeta): VelocityPoint[] {
  const baseBeatLen =
    meta.bpm > 0 ? 60000 / meta.bpm : (meta.timingPoints[0]?.beatLength ?? 500);

  type Event =
    | { time: number; kind: 0; beatLength: number }
    | { time: number; kind: 1; sv: number };
  const events: Event[] = [];
  for (const pt of meta.timingPoints)
    events.push({ time: pt.time, kind: 0, beatLength: pt.beatLength });
  for (const pt of meta.svPoints)
    events.push({ time: pt.time, kind: 1, sv: pt.svMultiplier });
  // A red line at the same timestamp applies before the green line
  events.sort((a, b) => a.time - b.time || a.kind - b.kind);

  const points: VelocityPoint[] = [];
  let curBeatLen = baseBeatLen;
  let curSv = 1.0;
  for (const ev of events) {
    if (ev.kind === 0) {
      curBeatLen = ev.beatLength > 0 ? ev.beatLength : curBeatLen;
      curSv = 1.0;
    } else {
      curSv = ev.sv;
    }
    points.push({
      time: ev.time,
      multiplier: (baseBeatLen / curBeatLen) * curSv,
    });
  }
  return points;
}

function buildBarlineTimes(
  meta: BeatmapMeta,
  startMs: number,
  endMs: number,
): number[] {
  const times: number[] = [];
  const reds = meta.timingPoints;
  for (let i = 0; i < reds.length; i++) {
    const red = reds[i];
    if (!red) continue;
    const step = red.beatLength * red.meter;
    if (!(step > 0)) continue;
    const sectionEnd = Math.min(reds[i + 1]?.time ?? endMs, endMs);
    // Skip ahead instead of stepping from a red line far before the window
    let t = red.time;
    if (t < startMs) t += Math.floor((startMs - t) / step) * step;
    for (; t < sectionEnd && times.length < 20000; t += step) {
      if (t >= startMs) times.push(t);
    }
  }
  return times;
}

interface DrumEvent {
  time: number;
  isKat: boolean;
  isBig: boolean;
}

// Autoplay input timeline: hit notes map 1:1, drumrolls tick as dons,
// swells alternate don/kat, all at eighth-note rate.
function buildDrumEvents(meta: BeatmapMeta): DrumEvent[] {
  const events: DrumEvent[] = [];
  for (const note of meta.taikoNotes) {
    if (note.kind === 'hit') {
      events.push({
        time: note.startTime,
        isKat: note.isKat,
        isBig: note.isBig,
      });
      continue;
    }
    let beatLen = 500;
    for (const pt of meta.timingPoints) {
      if (pt.time > note.startTime) break;
      beatLen = pt.beatLength;
    }
    const interval = Math.max(80, beatLen / 2);
    const isSwell = note.kind === 'swell';
    let tick = 0;
    for (
      let t = note.startTime;
      t <= note.endTime && events.length < 100_000;
      t += interval, tick++
    ) {
      events.push({ time: t, isKat: isSwell && tick % 2 === 1, isBig: false });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

// ─── Main renderer ───

export class TaikoRenderer implements Renderer {
  readonly gamemode = 'taiko';
  readonly width = TW;
  readonly height = TH;

  async renderFrames(
    ctx: RenderContext,
    onFrame: (buffer: Buffer, frameIdx: number, total: number) => Promise<void>,
  ): Promise<void> {
    const { meta, startMs, durationMs, scrollMs, fps, opts } = ctx;
    const canvas = createCanvas(TW, TH);
    const c = canvas.getContext('2d');

    const totalFrames = Math.ceil((durationMs / 1000) * fps);
    const notes = meta.taikoNotes;
    const noteCount = notes.length;
    const strainEnabled = opts.strainOverlay ?? true;

    const velTable = buildSvTable(
      buildVelocityPoints(meta),
      startMs,
      startMs + durationMs + scrollMs,
    );
    const xOf = (vis: number, currentVis: number) =>
      HIT_X + ((vis - currentVis) / scrollMs) * TRAVEL_W;

    // Precompute per-note visual positions
    const startVis = new Float64Array(noteCount);
    const endVis = new Float64Array(noteCount);
    for (let i = 0; i < noteCount; i++) {
      const note = notes[i];
      if (!note) continue;
      const sv = svAt(velTable, note.startTime);
      startVis[i] = sv;
      endVis[i] =
        note.endTime > note.startTime ? svAt(velTable, note.endTime) : sv;
    }

    const barTimes = buildBarlineTimes(
      meta,
      startMs - scrollMs,
      startMs + durationMs + scrollMs,
    );
    const barVis = new Float64Array(barTimes.length);
    for (let i = 0; i < barTimes.length; i++)
      barVis[i] = svAt(velTable, barTimes[i] ?? 0);

    // Sprites and static layers
    const sprites = {
      donSmall: buildNoteSprite(COLOR_DON, R_SMALL),
      donBig: buildNoteSprite(COLOR_DON, R_BIG),
      katSmall: buildNoteSprite(COLOR_KAT, R_SMALL),
      katBig: buildNoteSprite(COLOR_KAT, R_BIG),
      rollSmall: buildNoteSprite(COLOR_ROLL, R_SMALL),
      rollBig: buildNoteSprite(COLOR_ROLL, R_BIG),
      swell: buildNoteSprite(COLOR_SWELL, R_BIG),
    };
    const hitTarget = buildHitTargetSprite();
    const burstDon = buildHitBurstSprite('232,68,46');
    const burstKat = buildHitBurstSprite('63,167,221');
    const drumBase = buildDrumBaseSprite();
    const drumFlash = buildDrumFlashSprites();
    const drumEvents = buildDrumEvents(meta);
    const strainOverlay = strainEnabled
      ? buildStrainOverlay(
          meta.strainValues,
          meta.strainSectionMs,
          meta.strainStartMs,
          startMs,
          durationMs,
          {
            width: TW,
            footerH: FOOTER_H,
            padX: FOOTER_PAD_X,
            padY: FOOTER_PAD_Y,
          },
        )
      : null;
    const baseLayer = buildBaseLayer(meta, strainOverlay);

    // Notes are consumed at the hit target (autoplay hits everything), so
    // nothing is drawn left of HIT_X. Barlines scroll on until the
    // playfield's left edge.
    const barLeftCutoffVis = ((HIT_X - PLAYFIELD_LEFT) / TRAVEL_W) * scrollMs;
    const rightCutoffVis = ((TW - HIT_X + R_BIG * 2) / TRAVEL_W) * scrollMs;

    let activeStart = 0;
    let activeEnd = 0;
    let barStart = 0;
    let drumEvStart = 0;

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const currentMs = startMs + (frameIdx / fps) * 1000;
      const currentVis = svAt(velTable, currentMs);

      c.drawImage(baseLayer, 0, 0);

      // Barlines
      while (
        barStart < barVis.length &&
        (barVis[barStart] ?? 0) < currentVis - barLeftCutoffVis
      )
        barStart++;
      c.fillStyle = 'rgba(255,255,255,0.10)';
      for (let i = barStart; i < barVis.length; i++) {
        const bv = barVis[i] ?? 0;
        if (bv > currentVis + rightCutoffVis) break;
        const x = xOf(bv, currentVis);
        if (x < PLAYFIELD_LEFT) continue;
        c.fillRect(Math.round(x), LANE_TOP + 2, 1, LANE_H - 4);
      }

      // Hit target (under notes so they cover it as they arrive)
      c.drawImage(
        hitTarget,
        HIT_X - hitTarget.width / 2,
        LANE_CY - hitTarget.height / 2,
      );

      // Advance the active-note window (a note is done once its end passes
      // the hit target)
      while (activeStart < noteCount) {
        if ((endVis[activeStart] ?? 0) >= currentVis) break;
        activeStart++;
      }
      if (activeEnd < activeStart) activeEnd = activeStart;
      while (activeEnd < noteCount) {
        const n = notes[activeEnd];
        if (!n || (startVis[activeEnd] ?? 0) > currentVis + rightCutoffVis)
          break;
        activeEnd++;
      }

      // Draw later notes first so earlier notes (closer to the hit target)
      // stack on top, matching taiko's visual convention. Hit notes pop the
      // moment their center crosses the target (the burst is the pop);
      // drumrolls and swells are eaten at the target until the tail passes.
      for (let i = activeEnd - 1; i >= activeStart; i--) {
        const note = notes[i];
        if (!note) continue;
        if ((endVis[i] ?? 0) < currentVis) continue;

        const r = note.isBig ? R_BIG : R_SMALL;
        const headX = Math.max(xOf(startVis[i] ?? 0, currentVis), HIT_X);

        if (note.kind === 'hit') {
          const spr = note.isKat
            ? note.isBig
              ? sprites.katBig
              : sprites.katSmall
            : note.isBig
              ? sprites.donBig
              : sprites.donSmall;
          c.drawImage(spr, headX - spr.width / 2, LANE_CY - spr.height / 2);
        } else if (note.kind === 'drumroll') {
          const tailX = xOf(endVis[i] ?? 0, currentVis);
          const bodyR = r * 0.82;
          c.fillStyle = COLOR_ROLL;
          c.globalAlpha = 0.85;
          roundRect(
            c,
            headX - bodyR,
            LANE_CY - bodyR,
            tailX - headX + bodyR * 2,
            bodyR * 2,
            bodyR,
          );
          c.fill();
          c.globalAlpha = 1;
          const spr = note.isBig ? sprites.rollBig : sprites.rollSmall;
          c.drawImage(spr, headX - spr.width / 2, LANE_CY - spr.height / 2);
        } else {
          const tailX = xOf(endVis[i] ?? 0, currentVis);
          c.fillStyle = COLOR_SWELL;
          c.globalAlpha = 0.3;
          c.fillRect(
            headX,
            LANE_CY - r * 0.4,
            Math.max(0, tailX - headX),
            r * 0.8,
          );
          c.globalAlpha = 1;
          c.drawImage(
            sprites.swell,
            headX - sprites.swell.width / 2,
            LANE_CY - sprites.swell.height / 2,
          );
        }
      }

      // Autoplay drum hit flashes, alternating left/right hands;
      // big notes light both hands
      c.drawImage(
        drumBase,
        DRUM_CX - drumBase.width / 2,
        LANE_CY - drumBase.height / 2,
      );
      while (
        drumEvStart < drumEvents.length &&
        (drumEvents[drumEvStart]?.time ?? 0) < currentMs - FLASH_MS
      )
        drumEvStart++;
      for (let i = drumEvStart; i < drumEvents.length; i++) {
        const ev = drumEvents[i];
        if (!ev || ev.time > currentMs) break;
        const left = ev.isKat ? drumFlash.outerLeft : drumFlash.innerLeft;
        const right = ev.isKat ? drumFlash.outerRight : drumFlash.innerRight;
        c.globalAlpha = 1 - (currentMs - ev.time) / FLASH_MS;
        const burst = ev.isKat ? burstKat : burstDon;
        c.drawImage(burst, HIT_X - burst.width / 2, LANE_CY - burst.height / 2);
        if (ev.isBig || i % 2 === 0)
          c.drawImage(
            left,
            DRUM_CX - left.width / 2,
            LANE_CY - left.height / 2,
          );
        if (ev.isBig || i % 2 === 1)
          c.drawImage(
            right,
            DRUM_CX - right.width / 2,
            LANE_CY - right.height / 2,
          );
        c.globalAlpha = 1;
      }

      // Strain footer cursor (footer itself is baked into the base layer)
      if (strainOverlay)
        drawStrainCursor(
          c,
          strainOverlay,
          currentMs,
          startMs,
          durationMs,
          TH - FOOTER_H,
        );

      await onFrame(canvas.data(), frameIdx, totalFrames);
    }
  }
}
