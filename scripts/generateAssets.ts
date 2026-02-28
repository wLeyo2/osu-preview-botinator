/**
 * Generates all note skin PNG assets into assets/notes/{style}/.
 *
 * Assets are drawn white-on-transparent at 128×128px. The renderer
 * tints them to the desired note color at draw-time using canvas compositing.
 *
 * Run once: bun scripts/generateAssets.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const SIZE = 128;
const R = SIZE / 2; // radius for circles

function save(dir: string, name: string, data: Buffer) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  console.log(`  wrote ${join(dir, name)}`);
}

function newCanvas(w = SIZE, h = SIZE) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  return { canvas, ctx };
}

// ─── BAR ──────────────────────────────────────────────────────────────────────

function generateBarNote(): Buffer {
  const { canvas, ctx } = newCanvas();
  const r = 14;

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, r);
  ctx.fill();

  // Top highlight stripe
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE * 0.35);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(4, 4, SIZE - 8, SIZE * 0.35, r * 0.6);
  ctx.fill();

  // Bottom shadow band
  const shadow = ctx.createLinearGradient(0, SIZE * 0.7, 0, SIZE);
  shadow.addColorStop(0, 'rgba(0,0,0,0)');
  shadow.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.roundRect(0, SIZE * 0.7, SIZE, SIZE * 0.3, [0, 0, r, r]);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

function generateBarHoldHead(): Buffer {
  return generateBarNote();
}

function generateBarHoldTail(): Buffer {
  const { canvas, ctx } = newCanvas();
  const barH = SIZE * 0.22;
  const y = (SIZE - barH) / 2;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.roundRect(0, y, SIZE, barH, barH / 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.roundRect(4, y + 2, SIZE - 8, barH * 0.4, barH / 2);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

/**
 * Hold body — a narrow vertical strip designed to be stretched vertically.
 * Uses a gradient that fades slightly at top and bottom edges so tiled
 * or stretched sections blend smoothly. Full width × 128px tall.
 */
function generateBarHoldBody(): Buffer {
  // Wider than tall — 64×128 so it tiles/stretches naturally vertically
  const W = 64;
  const H = SIZE;
  const { canvas, ctx } = newCanvas(W, H);

  // Main body fill — slightly transparent edges via gradient
  const bodyGrad = ctx.createLinearGradient(0, 0, W, 0);
  bodyGrad.addColorStop(0, 'rgba(255,255,255,0)');
  bodyGrad.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  bodyGrad.addColorStop(0.92, 'rgba(255,255,255,0.85)');
  bodyGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(0, 0, W, H);

  // Subtle centre highlight stripe
  const hlGrad = ctx.createLinearGradient(0, 0, W, 0);
  hlGrad.addColorStop(0, 'rgba(255,255,255,0)');
  hlGrad.addColorStop(0.35, 'rgba(255,255,255,0)');
  hlGrad.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  hlGrad.addColorStop(0.65, 'rgba(255,255,255,0)');
  hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hlGrad;
  ctx.fillRect(0, 0, W, H);

  return canvas.toBuffer('image/png');
}

// ─── CIRCLE ───────────────────────────────────────────────────────────────────

function generateCircleNote(): Buffer {
  const { canvas, ctx } = newCanvas();
  const cx = R;
  const cy = R;
  const outerR = R - 3;

  // Radial gradient fill — bright highlight off-centre for 3D look
  const grad = ctx.createRadialGradient(
    cx - outerR * 0.25,
    cy - outerR * 0.3,
    0,
    cx,
    cy,
    outerR,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.92)');
  grad.addColorStop(1, 'rgba(185,185,185,0.85)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fill();

  // Inner ring
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR * 0.6, 0, Math.PI * 2);
  ctx.stroke();

  // Centre dot
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, outerR * 0.16, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

function generateCircleHoldHead(): Buffer {
  return generateCircleNote();
}

function generateCircleHoldTail(): Buffer {
  const { canvas, ctx } = newCanvas();
  const cx = R;
  const cy = R;
  const rx = R - 8;
  const ry = SIZE * 0.12;

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - 6, ry * 0.5, 0, 0, Math.PI * 2);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

function generateCircleHoldBody(): Buffer {
  // Same strip as bar — circles use same body style
  return generateBarHoldBody();
}

// ─── ARROW ────────────────────────────────────────────────────────────────────
// Downward-pointing chevron with a sharper tip. shoulderY at 30% so the
// triangular portion is tall and clearly arrow-shaped at any aspect ratio.

function generateArrowNote(): Buffer {
  const { canvas, ctx } = newCanvas();
  const pad = 5;
  const left = pad;
  const right = SIZE - pad;
  const top = pad;
  const bottom = SIZE - pad;
  const cx = SIZE / 2;

  // Shoulder at 30% — leaves 70% of height for the triangular tip,
  // making it look like a proper arrow even when drawn wider than tall.
  const shoulderY = top + (SIZE - pad * 2) * 0.3;

  // Chevron fill
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, shoulderY);
  ctx.lineTo(cx, bottom); // arrow tip
  ctx.lineTo(left, shoulderY);
  ctx.closePath();
  ctx.fill();

  // Top highlight band (upper rectangle portion)
  const grad = ctx.createLinearGradient(0, top, 0, shoulderY);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0.05)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(left + 6, top + 4);
  ctx.lineTo(right - 6, top + 4);
  ctx.lineTo(right - 6, shoulderY);
  ctx.lineTo(left + 6, shoulderY);
  ctx.closePath();
  ctx.fill();

  // Edge highlight on left wing
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left + 2, top + 2);
  ctx.lineTo(left + 2, shoulderY);
  ctx.lineTo(cx, bottom - 4);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

function generateArrowHoldHead(): Buffer {
  return generateArrowNote();
}

// Arrow hold tail — small downward triangle
function generateArrowHoldTail(): Buffer {
  const { canvas, ctx } = newCanvas();
  const pad = 14;
  const cx = SIZE / 2;
  const top = SIZE * 0.28;
  const bottom = SIZE * 0.78;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(pad, top);
  ctx.lineTo(SIZE - pad, top);
  ctx.lineTo(cx, bottom);
  ctx.closePath();
  ctx.fill();

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.moveTo(pad + 8, top + 4);
  ctx.lineTo(SIZE - pad - 8, top + 4);
  ctx.lineTo(cx, top + (bottom - top) * 0.35);
  ctx.closePath();
  ctx.fill();

  return canvas.toBuffer('image/png');
}

function generateArrowHoldBody(): Buffer {
  return generateBarHoldBody();
}

// ─── Generate all ─────────────────────────────────────────────────────────────

const base = join(import.meta.dir, '..', 'assets', 'notes');

console.log('Generating note assets...');

const styles: Array<{
  dir: string;
  note: () => Buffer;
  holdHead: () => Buffer;
  holdTail: () => Buffer;
  holdBody: () => Buffer;
}> = [
  {
    dir: join(base, 'bar'),
    note: generateBarNote,
    holdHead: generateBarHoldHead,
    holdTail: generateBarHoldTail,
    holdBody: generateBarHoldBody,
  },
  {
    dir: join(base, 'circle'),
    note: generateCircleNote,
    holdHead: generateCircleHoldHead,
    holdTail: generateCircleHoldTail,
    holdBody: generateCircleHoldBody,
  },
  {
    dir: join(base, 'arrow'),
    note: generateArrowNote,
    holdHead: generateArrowHoldHead,
    holdTail: generateArrowHoldTail,
    holdBody: generateArrowHoldBody,
  },
];

for (const { dir, note, holdHead, holdTail, holdBody } of styles) {
  console.log(`\n${dir.split('/').at(-1)}:`);
  save(dir, 'note.png', note());
  save(dir, 'hold-head.png', holdHead());
  save(dir, 'hold-tail.png', holdTail());
  save(dir, 'hold-body.png', holdBody());
}

console.log('\nDone.');
