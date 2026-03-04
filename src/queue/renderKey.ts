import { createHash } from 'node:crypto';
import config from '@/utils/config';
import type { RenderOptions } from '@/utils/osu/renderer';
import {
  NOTE_COLOR_SPECIAL_DEFAULT,
  NOTE_COLORS_DEFAULT,
  NOTE_STYLE_DEFAULT,
  RENDER_MODE_DEFAULT,
  type RenderMode,
  SCROLL_DIRECTION_DEFAULT,
  STRAIN_OVERLAY_DEFAULT,
} from '@/utils/osu/userPrefs';

interface RenderKeyInput {
  beatmapId: string;
  scrollMs: number;
  renderMode: RenderMode;
  renderOpts: RenderOptions;
}

function normalizeRenderOptions(opts: RenderOptions): RenderOptions {
  return {
    noteStyle: opts.noteStyle ?? NOTE_STYLE_DEFAULT,
    noteColors: (opts.noteColors ?? NOTE_COLORS_DEFAULT).map((c) =>
      c.toLowerCase(),
    ),
    noteColorSpecial: (
      opts.noteColorSpecial ?? NOTE_COLOR_SPECIAL_DEFAULT
    ).toLowerCase(),
    scrollDirection: opts.scrollDirection ?? SCROLL_DIRECTION_DEFAULT,
    strainOverlay: opts.strainOverlay ?? STRAIN_OVERLAY_DEFAULT,
  };
}

export function buildRenderKey(input: RenderKeyInput): string {
  const normalizedPayload = {
    v: config.render.rendererVersion,
    fps: config.render.fps,
    beatmapId: input.beatmapId,
    scrollMs: Math.max(1, Math.floor(input.scrollMs)),
    renderMode: input.renderMode || RENDER_MODE_DEFAULT,
    renderOpts: normalizeRenderOptions(input.renderOpts),
  };

  return createHash('sha256')
    .update(JSON.stringify(normalizedPayload))
    .digest('hex');
}
