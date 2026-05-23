import { createCanvas } from '@napi-rs/canvas';

export const VIDEO_WIDTH = 180;
export const VIDEO_HEIGHT = 320;

export const HEADER_H = Math.round(VIDEO_HEIGHT * 0.156);
export const COL_GAP = Math.max(2, Math.round(VIDEO_WIDTH * 0.011));
export const PLAYFIELD_H =
  VIDEO_HEIGHT - Math.round(VIDEO_HEIGHT * 0.109) - HEADER_H;
const HITLINE_GLOW = 'rgba(255,255,255,0.18)';
const HITLINE_COLOR = '#ffffff';

export interface HeaderLayer {
  canvas: import('@napi-rs/canvas').Canvas;
  badgeX: number;
  badgeY: number;
  badgeW: number;
  badgeH: number;
}

function starColor(stars: number): string {
  if (stars < 2) return '#4fc3f7';
  if (stars < 3) return '#81c784';
  if (stars < 4) return '#ffee58';
  if (stars < 5) return '#ffa726';
  if (stars < 6) return '#ef5350';
  if (stars < 7) return '#ab47bc';
  return '#212121';
}

function roundRect(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
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

export function buildHeaderLayer(meta: {
  artist: string;
  title: string;
  version: string;
  keys: number;
  creator: string;
  stars: number;
}): HeaderLayer {
  const canvas = createCanvas(VIDEO_WIDTH, HEADER_H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(0, 0, VIDEO_WIDTH, HEADER_H);

  const titleSize = Math.round(HEADER_H * 0.15);
  const metaSize = Math.round(HEADER_H * 0.12);
  const subSize = Math.round(HEADER_H * 0.11);
  const badgeSize = Math.round(HEADER_H * 0.13);
  const padX = Math.round(VIDEO_WIDTH * 0.033);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillText(
    `${meta.artist} - ${meta.title}`,
    padX,
    HEADER_H * 0.36,
    VIDEO_WIDTH - padX * 2,
  );

  ctx.font = `${metaSize}px sans-serif`;
  ctx.fillStyle = '#cccccc';
  ctx.fillText(
    `[${meta.version}]  •  ${meta.keys}K`,
    padX,
    HEADER_H * 0.56,
    VIDEO_WIDTH - padX * 2,
  );

  ctx.fillStyle = '#888888';
  ctx.font = `${subSize}px sans-serif`;
  ctx.fillText(
    `mapped by ${meta.creator}`,
    padX,
    HEADER_H * 0.74,
    VIDEO_WIDTH - padX * 2,
  );

  const starsText = `${meta.stars.toFixed(2)} ★`;
  ctx.font = `bold ${badgeSize}px sans-serif`;
  const starTextW = ctx.measureText(starsText).width;
  const badgePad = Math.round(HEADER_H * 0.08);
  const badgeH = Math.round(HEADER_H * 0.22);
  const badgeW = starTextW + badgePad * 2;
  const badgeX = VIDEO_WIDTH - badgeW - Math.round(VIDEO_WIDTH * 0.028);
  const badgeY = HEADER_H / 2 - badgeH / 2;

  const starCol = starColor(meta.stars);
  ctx.fillStyle = starCol;
  roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.fillStyle = meta.stars < 3 ? '#1a1a1a' : '#ffffff';
  ctx.fillText(
    starsText,
    badgeX + badgePad,
    badgeY + Math.round(badgeH * 0.68),
  );

  return { canvas, badgeX, badgeY, badgeW, badgeH };
}

export function buildColumnsLayer(
  keys: number,
  colWidth: number,
): import('@napi-rs/canvas').Canvas {
  const canvas = createCanvas(VIDEO_WIDTH, PLAYFIELD_H + 70);
  const ctx = canvas.getContext('2d');
  for (let col = 0; col <= keys; col++) {
    const x = col === 0 ? 0 : (col + 1) * COL_GAP + col * colWidth;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, 0, COL_GAP, PLAYFIELD_H + Math.round(VIDEO_HEIGHT * 0.109));
  }
  return canvas;
}

export function buildHitLineLayer(
  _hitLineY: number,
): import('@napi-rs/canvas').Canvas {
  const h = Math.round(VIDEO_HEIGHT * 0.028);
  const canvas = createCanvas(VIDEO_WIDTH, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = HITLINE_GLOW;
  ctx.fillRect(0, 0, VIDEO_WIDTH, h);
  ctx.fillStyle = HITLINE_COLOR;
  ctx.fillRect(
    0,
    Math.round(h * 0.44),
    VIDEO_WIDTH,
    Math.max(1, Math.round(h * 0.11)),
  );
  return canvas;
}
