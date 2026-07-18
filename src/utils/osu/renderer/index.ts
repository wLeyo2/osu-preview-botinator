import { ManiaRenderer } from './mania';
import { TaikoRenderer } from './taiko';
import type { Renderer } from './types';

export { VIDEO_HEIGHT, VIDEO_WIDTH } from './layers';
export type {
  NoteStyle,
  RenderContext,
  Renderer,
  RenderOptions,
} from './types';

export const DEFAULT_SCROLL_MS = 500;

const maniaRenderer = new ManiaRenderer();
const taikoRenderer = new TaikoRenderer();

/**
 * Renderer per game mode. osu!standard maps render through the mania
 * renderer (empty playfield + strain footer), preserving prior behavior.
 */
export function getRenderer(mode: number): Renderer {
  if (mode === 1) return taikoRenderer;
  return maniaRenderer;
}
