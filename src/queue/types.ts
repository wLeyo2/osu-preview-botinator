import type { RenderOptions } from '@/utils/osu/renderer';
import type { RenderMode } from '@/utils/osu/userPrefs';

export interface RenderJobData {
  renderKey: string;
  sourceUrl: string;
  beatmapId: string;
  beatmapSetId?: string;
  requesterId: string;
  scrollMs: number;
  renderMode: RenderMode;
  renderOpts: RenderOptions;
}

export interface RenderResult {
  renderKey: string;
  sourceUrl: string;
  beatmapId: string;
  beatmapSetId: string;
  beatmapTitle?: string;
  videoUrl: string;
  createdAt: number;
}

export interface ChannelSubscription {
  guildId: string;
  channelId: string;
  messageId?: string;
}
