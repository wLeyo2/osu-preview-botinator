/**
 * Loads and caches all note skin PNG assets from disk.
 * Call loadNoteAssets() once at startup; pass the result to renderFrames.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Image } from '@napi-rs/canvas';
import { loadImage } from '@napi-rs/canvas';
import type { NoteStyle } from './userPrefs';

export interface NoteSkinAssets {
  /** Normal (non-hold) note */
  note: Image;
  /** Head cap of a hold note */
  holdHead: Image;
  /** Tail cap of a hold note */
  holdTail: Image;
  /** Body strip of a hold note — stretched vertically between head and tail */
  holdBody: Image;
}

/** Map from NoteStyle → loaded images */
export type SkinMap = Record<NoteStyle, NoteSkinAssets>;

const ASSET_ROOT = join(import.meta.dir, '..', '..', '..', 'assets', 'notes');

async function loadSkin(style: NoteStyle): Promise<NoteSkinAssets> {
  const dir = join(ASSET_ROOT, style);
  const [note, holdHead, holdTail, holdBody] = await Promise.all([
    loadImage(readFileSync(join(dir, 'note.png'))),
    loadImage(readFileSync(join(dir, 'hold-head.png'))),
    loadImage(readFileSync(join(dir, 'hold-tail.png'))),
    loadImage(readFileSync(join(dir, 'hold-body.png'))),
  ]);
  return { note, holdHead, holdTail, holdBody };
}

let _cached: SkinMap | null = null;

/**
 * Load all note skin assets from disk.
 * Results are cached so subsequent calls are free.
 */
export async function loadNoteAssets(): Promise<SkinMap> {
  if (_cached) return _cached;

  const [bar, circle, arrow] = await Promise.all([
    loadSkin('bar'),
    loadSkin('circle'),
    loadSkin('arrow'),
  ]);

  _cached = { bar, circle, arrow };
  return _cached;
}
