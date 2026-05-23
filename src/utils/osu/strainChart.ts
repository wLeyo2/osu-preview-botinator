import { createCanvas } from '@napi-rs/canvas';
import type { BeatmapMeta } from './parseBeatmap';

// ─── Chart dimensions ──────────────────────────────────────────────────────────

const CHART_W = 800;
const CHART_H = 200;
const PAD_L = 0;
const PAD_R = 0;
const PAD_T = 12;
const PAD_B = 24; // space for time labels
const BAR_GAP = 1; // px gap between bars

// ─── Colours ──────────────────────────────────────────────────────────────────

const BG = '#1a1a2e';
const GRID_LINE = 'rgba(255,255,255,0.07)';
const AXIS_TEXT = 'rgba(255,255,255,0.45)';

/** Bar colour based on relative intensity (0‥1) */
function barColor(intensity: number): string {
  // Gradient: blue → cyan → yellow → red (similar to owo bot)
  if (intensity < 0.33) {
    const t = intensity / 0.33;
    const r = Math.round(30 + t * 0);
    const g = Math.round(100 + t * 155);
    const b = Math.round(255);
    return `rgb(${r},${g},${b})`;
  }
  if (intensity < 0.66) {
    const t = (intensity - 0.33) / 0.33;
    const r = Math.round(30 + t * 225);
    const g = Math.round(255 - t * 55);
    const b = Math.round(255 - t * 255);
    return `rgb(${r},${g},${b})`;
  }
  const t = (intensity - 0.66) / 0.34;
  const r = 255;
  const g = Math.round(200 - t * 200);
  const b = 0;
  return `rgb(${r},${g},${b})`;
}

/**
 * Renders a strain chart image (PNG buffer) similar to the owo Discord bot.
 *
 * @param meta  Parsed beatmap metadata (must include strainValues)
 * @returns     PNG buffer ready to send as a Discord attachment
 */
export function renderStrainChart(meta: BeatmapMeta): Buffer {
  const canvas = createCanvas(CHART_W, CHART_H);
  const ctx = canvas.getContext('2d');

  const values = meta.strainValues;

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CHART_W, CHART_H);

  if (values.length === 0) {
    ctx.fillStyle = AXIS_TEXT;
    ctx.font = '14px sans-serif';
    ctx.fillText('No strain data available', CHART_W / 2 - 80, CHART_H / 2);
    return canvas.toBuffer('image/png');
  }

  const plotW = CHART_W - PAD_L - PAD_R;
  const plotH = CHART_H - PAD_T - PAD_B;

  let maxStrain = 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (v > maxStrain) maxStrain = v;
  }

  // Horizontal grid lines at 25 / 50 / 75 %
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  for (const pct of [0.25, 0.5, 0.75]) {
    const y = PAD_T + plotH * (1 - pct);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
  }

  // Bars
  const n = values.length;
  const barW = Math.max(1, (plotW - BAR_GAP * (n - 1)) / n);

  for (let i = 0; i < n; i++) {
    const val = values[i] ?? 0;
    const intensity = val / maxStrain;
    const barH = Math.max(1, intensity * plotH);
    const x = PAD_L + i * (barW + BAR_GAP);
    const y = PAD_T + plotH - barH;

    ctx.fillStyle = barColor(intensity);
    ctx.fillRect(x, y, barW, barH);
  }

  // Time axis labels (every ~30 seconds)
  const totalMs = n * meta.strainSectionMs;
  const totalSec = totalMs / 1000;
  const labelIntervalSec = totalSec > 180 ? 60 : totalSec > 60 ? 30 : 15;

  ctx.fillStyle = AXIS_TEXT;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';

  for (let sec = 0; sec <= totalSec; sec += labelIntervalSec) {
    const frac = sec / totalSec;
    const x = PAD_L + frac * plotW;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const label = `${m}:${s.toString().padStart(2, '0')}`;
    ctx.fillText(label, x, CHART_H - 6);

    // Tick mark
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD_T + plotH);
    ctx.lineTo(x, PAD_T + plotH + 4);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}
