import type { Canvas, Image } from '@napi-rs/canvas';
import { createCanvas } from '@napi-rs/canvas';

export type TintedAssetCache = Map<string, Canvas>;

export function getTintedCanvas(
  cache: TintedAssetCache,
  asset: Image,
  assetKey: string,
  color: string,
  w: number,
  h: number,
): Canvas {
  const key = `${assetKey}:${color}:${w}x${h}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(asset, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  cache.set(key, canvas);
  return canvas;
}

export function drawTintedAsset(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
  cache: TintedAssetCache,
  asset: Image,
  assetKey: string,
  color: string,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const tinted = getTintedCanvas(cache, asset, assetKey, color, w, h);
  ctx.globalAlpha = alpha;
  ctx.drawImage(tinted, x, y);
  ctx.globalAlpha = 1;
}

export function drawTintedAssetClipped(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
  cache: TintedAssetCache,
  asset: Image,
  assetKey: string,
  color: string,
  alpha: number,
  x: number,
  y: number,
  w: number,
  h: number,
  sourceH: number,
): void {
  const tinted = getTintedCanvas(cache, asset, assetKey, color, w, sourceH);
  ctx.globalAlpha = alpha;
  ctx.drawImage(tinted, 0, 0, w, h, x, y, w, h);
  ctx.globalAlpha = 1;
}
