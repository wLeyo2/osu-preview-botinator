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
