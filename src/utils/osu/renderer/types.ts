import type { BeatmapMeta } from '@/utils/osu/parseBeatmap';
import type { ScrollDirection } from '@/utils/osu/userPrefs';

export type NoteStyle = 'bar' | 'circle' | 'arrow';

export interface RenderOptions {
  noteStyle?: NoteStyle;
  noteColors?: string[];
  noteColorSpecial?: string;
  scrollDirection?: ScrollDirection;
  strainOverlay?: boolean;
}

export interface RenderContext {
  meta: BeatmapMeta;
  startMs: number;
  durationMs: number;
  scrollMs: number;
  fps: number;
  opts: RenderOptions;
}

export interface Renderer {
  readonly gamemode: string;
  /** Canvas dimensions for this mode (mania is portrait, taiko landscape) */
  readonly width: number;
  readonly height: number;
  renderFrames(
    ctx: RenderContext,
    onFrame: (buffer: Buffer, frameIdx: number, total: number) => Promise<void>,
  ): Promise<void>;
}
