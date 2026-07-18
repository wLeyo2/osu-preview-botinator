import { createCanvas } from '@napi-rs/canvas';

// ─── Strain footer overlay (shared across renderers) ───

export interface StrainDims {
  width: number;
  footerH: number;
  padX: number;
  padY: number;
}

export interface StrainOverlay {
  canvas: import('@napi-rs/canvas').Canvas;
  plotX: number;
  plotY: number;
  plotH: number;
  profileY: Float32Array;
}

export function buildStrainOverlay(
  strainValues: Float64Array,
  strainSectionMs: number,
  strainStartMs: number,
  startMs: number,
  durationMs: number,
  dims: StrainDims,
): StrainOverlay | null {
  if (strainValues.length === 0 || durationMs <= 0) return null;
  const { width, footerH, padX, padY } = dims;
  const plotX = padX;
  const plotY = padY + 8;
  const plotW = width - padX * 2;
  const plotH = footerH - plotY - padY;
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
  const footerCanvas = createCanvas(width, footerH);
  const fCtx = footerCanvas.getContext('2d');

  fCtx.fillStyle = 'rgba(0,0,0,0.42)';
  fCtx.fillRect(0, 0, width, footerH);
  fCtx.fillStyle = 'rgba(255,255,255,0.4)';
  fCtx.font = `${Math.max(8, Math.round(footerH * 0.23))}px sans-serif`;
  fCtx.fillText('strain', plotX, padY + Math.round(footerH * 0.16));
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

export function drawStrainCursor(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
  overlay: StrainOverlay,
  currentMs: number,
  startMs: number,
  durationMs: number,
  footerY: number,
): void {
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
