import type { Strains } from 'rosu-pp-js';
import { Difficulty, GameMode, Beatmap as RosuBeatmap } from 'rosu-pp-js';

export interface ManiaNote {
  /** Column index (0-based). Derived from x-coordinate and key count. */
  column: number;
  /** Start time in milliseconds */
  startTime: number;
  /** End time in milliseconds (equals startTime for regular notes, >startTime for hold notes) */
  endTime: number;
  isHold: boolean;
}

/** A single SV (scroll velocity) control point parsed from [TimingPoints]. */
export interface SvPoint {
  /** Time in milliseconds when this SV takes effect. */
  time: number;
  /**
   * SV multiplier relative to the base scroll speed.
   * Derived from inherited timing points: svMultiplier = -100 / beatLength.
   * Always >= 0.01 (clamped to avoid zero/negative).
   */
  svMultiplier: number;
}

export type TaikoNoteKind = 'hit' | 'drumroll' | 'swell';

export interface TaikoNote {
  startTime: number;
  endTime: number;
  kind: TaikoNoteKind;
  /** Rim hit (blue); only meaningful for kind "hit" */
  isKat: boolean;
  /** Finisher (large note) */
  isBig: boolean;
}

/** Uninherited (red line) timing point */
export interface TimingPoint {
  time: number;
  beatLength: number;
  meter: number;
}

export interface BeatmapMeta {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  version: string;
  /** Game mode: 0=std, 1=taiko, 3=mania */
  mode: number;
  /** Key count. For mania this is the CS field. */
  keys: number;
  hp: number;
  od: number;
  ar: number;
  /** Star rating computed via rosu-pp-js */
  stars: number;
  /** Drain time in seconds (last note time - first note time, minus breaks) */
  drainSeconds: number;
  /** BPM from rosu-pp-js Beatmap */
  bpm: number;
  /** All mania hit objects (only populated when mode === 3) */
  notes: ManiaNote[];
  /** All taiko hit objects (only populated when mode === 1) */
  taikoNotes: TaikoNote[];
  /** Uninherited timing points (only populated when mode === 1) */
  timingPoints: TimingPoint[];
  /** Start time of the first hit object in ms (any mode) */
  firstObjectMs: number;
  /** End time of the last hit object in ms (any mode) */
  lastObjectMs: number;
  /**
   * Strain values from rosu-pp-js for the chart.
   * Each value covers `strainSectionMs` ms of the map.
   */
  strainValues: Float64Array;
  /** Duration of each strain section in ms */
  strainSectionMs: number;
  /** Map-time origin (ms) used for strain section index 0 */
  strainStartMs: number;
  /**
   * SV control points from inherited timing points (green lines).
   * Only populated for mania maps. Empty array = constant SV 1.0.
   * Sorted ascending by time.
   */
  svPoints: SvPoint[];
}

type BeatmapFieldIndex = Map<string, string>;

function buildFieldIndex(raw: string): BeatmapFieldIndex {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('['))
      continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;

    const key = trimmed.slice(0, colon).trim();
    if (!key || fields.has(key)) continue;

    fields.set(key, trimmed.slice(colon + 1).trim());
  }
  return fields;
}

function parseMetaField(fields: BeatmapFieldIndex, key: string): string {
  return fields.get(key) ?? '';
}

function parseNumericField(
  fields: BeatmapFieldIndex,
  key: string,
  fallback = 0,
): number {
  const raw = fields.get(key);
  if (!raw) return fallback;
  const numericPrefix = raw.match(/^-?\d+(?:\.\d+)?/);
  if (!numericPrefix) return fallback;
  const parsed = Number(numericPrefix[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse all HitObjects from a raw .osu file for mania rendering */
function parseManiaObjects(raw: string, keys: number): ManiaNote[] {
  const hitObjectsSection = raw.split(/^\[HitObjects\]/m)[1];
  if (!hitObjectsSection) return [];

  const notes: ManiaNote[] = [];
  let sorted = true;
  let prevStart = Number.NEGATIVE_INFINITY;
  let prevEnd = Number.NEGATIVE_INFINITY;

  for (const line of hitObjectsSection.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue; // skip blank/comment lines
    if (trimmed.startsWith('[')) break; // new section — stop

    const parts = trimmed.split(',');
    if (parts.length < 5) continue;

    const x = parseInt(parts[0] ?? '0', 10);
    const startTime = parseInt(parts[2] ?? '0', 10);
    const typeFlag = parseInt(parts[3] ?? '0', 10);

    if (Number.isNaN(x) || Number.isNaN(startTime) || Number.isNaN(typeFlag)) {
      continue;
    }

    // Column from x-coordinate: column = floor(x * keys / 512)
    const column = Math.min(Math.floor((x * keys) / 512), keys - 1);

    // Hold note: bit 7 set (128). Format: x,y,time,type,hitSound,endTime:hitSample
    const isHold = (typeFlag & 128) !== 0;
    let endTime = startTime;

    if (isHold && parts.length >= 6) {
      const endPart = parts[5]?.split(':')[0] ?? '';
      const parsed = parseInt(endPart, 10);
      if (!Number.isNaN(parsed) && parsed > startTime) {
        endTime = parsed;
      }
    }

    if (
      startTime < prevStart ||
      (startTime === prevStart && endTime < prevEnd)
    ) {
      sorted = false;
    }
    prevStart = startTime;
    prevEnd = endTime;

    notes.push({ column, startTime, endTime, isHold });
  }

  if (!sorted) {
    notes.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }
  return notes;
}

// ─── Taiko hit objects ───

const HITSOUND_WHISTLE = 2;
const HITSOUND_FINISH = 4;
const HITSOUND_CLAP = 8;

function parseTaikoObjects(
  raw: string,
  timingPoints: TimingPoint[],
  svPoints: SvPoint[],
  sliderMultiplier: number,
): TaikoNote[] {
  const section = raw.split(/^\[HitObjects\]/m)[1];
  if (!section) return [];

  const notes: TaikoNote[] = [];
  let sorted = true;
  let prevStart = Number.NEGATIVE_INFINITY;

  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('[')) break;

    const parts = trimmed.split(',');
    if (parts.length < 5) continue;

    const startTime = parseInt(parts[2] ?? '0', 10);
    const typeFlag = parseInt(parts[3] ?? '0', 10);
    const hitSound = parseInt(parts[4] ?? '0', 10);
    if (Number.isNaN(startTime) || Number.isNaN(typeFlag)) continue;

    const isBig = (hitSound & HITSOUND_FINISH) !== 0;
    let note: TaikoNote | null = null;

    if (typeFlag & 1) {
      const isKat = (hitSound & (HITSOUND_WHISTLE | HITSOUND_CLAP)) !== 0;
      note = { startTime, endTime: startTime, kind: 'hit', isKat, isBig };
    } else if (typeFlag & 2) {
      // Slider = drumroll; duration derives from pixel length and timing
      const slides = Math.max(1, parseInt(parts[6] ?? '1', 10) || 1);
      const pixelLength = parseFloat(parts[7] ?? '0') || 0;
      const beatLength = beatLengthAt(timingPoints, startTime);
      const sv = svMultiplierAt(svPoints, timingPoints, startTime);
      const spanMs = (pixelLength / (sliderMultiplier * 100 * sv)) * beatLength;
      const durationMs = Number.isFinite(spanMs) ? spanMs * slides : 0;
      note = {
        startTime,
        endTime: startTime + Math.max(0, Math.round(durationMs)),
        kind: 'drumroll',
        isKat: false,
        isBig,
      };
    } else if (typeFlag & 8) {
      // Spinner = swell (denden)
      const endTime = parseInt(parts[5] ?? '0', 10);
      note = {
        startTime,
        endTime: Number.isNaN(endTime)
          ? startTime
          : Math.max(startTime, endTime),
        kind: 'swell',
        isKat: false,
        isBig,
      };
    }

    if (!note) continue;
    if (note.startTime < prevStart) sorted = false;
    prevStart = note.startTime;
    notes.push(note);
  }

  if (!sorted) notes.sort((a, b) => a.startTime - b.startTime);
  return notes;
}

function beatLengthAt(timingPoints: TimingPoint[], timeMs: number): number {
  let beatLength = timingPoints[0]?.beatLength ?? 500;
  for (const pt of timingPoints) {
    if (pt.time > timeMs) break;
    beatLength = pt.beatLength;
  }
  return beatLength > 0 ? beatLength : 500;
}

/** An uninherited point resets SV to 1.0; inherited points after it apply. */
function svMultiplierAt(
  svPoints: SvPoint[],
  timingPoints: TimingPoint[],
  timeMs: number,
): number {
  let lastReset = Number.NEGATIVE_INFINITY;
  for (const pt of timingPoints) {
    if (pt.time > timeMs) break;
    lastReset = pt.time;
  }
  let sv = 1.0;
  for (const pt of svPoints) {
    if (pt.time > timeMs) break;
    sv = pt.time >= lastReset ? pt.svMultiplier : 1.0;
  }
  return sv;
}

function parseUninheritedPoints(raw: string): TimingPoint[] {
  const section = raw.split(/^\[TimingPoints\]/m)[1]?.split(/^\[/m)[0];
  if (!section) return [];

  const points: TimingPoint[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('[')) break;

    const parts = trimmed.split(',');
    if (parts.length < 2) continue;

    const time = parseFloat(parts[0] ?? '0');
    const beatLength = parseFloat(parts[1] ?? '0');
    const meter = parseInt(parts[2] ?? '4', 10);
    const uninherited = parseInt(parts[6] ?? '1', 10);

    if (Number.isNaN(time) || Number.isNaN(beatLength)) continue;
    if (uninherited === 0 || beatLength <= 0) continue;

    points.push({
      time,
      beatLength,
      meter: Number.isNaN(meter) || meter <= 0 ? 4 : meter,
    });
  }

  points.sort((a, b) => a.time - b.time);
  return points;
}

/** Compute drain time in seconds from hit object timestamps and break periods */
function computeDrainSeconds(
  raw: string,
  firstTime: number,
  lastTime: number,
): number {
  if (lastTime <= firstTime) return 0;

  // Parse break periods to subtract from drain time
  let breakMs = 0;
  const breaksSection = raw.split(/^\[Events\]/m)[1]?.split(/^\[/m)[0] ?? '';
  for (const line of breaksSection.split('\n')) {
    const parts = line.trim().split(',');
    if (parts[0]?.trim() === '2' && parts.length >= 3) {
      const breakStart = parseInt(parts[1] ?? '0', 10);
      const breakEnd = parseInt(parts[2] ?? '0', 10);
      if (
        !Number.isNaN(breakStart) &&
        !Number.isNaN(breakEnd) &&
        breakEnd > breakStart
      ) {
        breakMs += breakEnd - breakStart;
      }
    }
  }

  return Math.max(0, (lastTime - firstTime - breakMs) / 1000);
}

function computeStrainStartMs(
  firstObjectMs: number,
  sectionMs: number,
): number {
  const section = Math.max(1, Math.floor(sectionMs));
  return Math.max(0, Math.floor(firstObjectMs / section) * section);
}

/**
 * Parses all relevant data from a raw .osu file for the Discord bot.
 * Uses rosu-pp-js for star rating and BPM.
 */
export function parseBeatmap(rawBeatmap: string): BeatmapMeta {
  const fields = buildFieldIndex(rawBeatmap);
  const mode = parseNumericField(fields, 'Mode', 0);

  // Metadata
  const title = parseMetaField(fields, 'Title');
  const titleUnicode = parseMetaField(fields, 'TitleUnicode') || title;
  const artist = parseMetaField(fields, 'Artist');
  const artistUnicode = parseMetaField(fields, 'ArtistUnicode') || artist;
  const creator = parseMetaField(fields, 'Creator');
  const version = parseMetaField(fields, 'Version');

  // Difficulty fields from raw .osu
  const hp = parseNumericField(fields, 'HPDrainRate', 5);
  const od = parseNumericField(fields, 'OverallDifficulty', 5);
  const ar = parseNumericField(fields, 'ApproachRate', 5);
  // In mania, CS = key count
  const keys = Math.round(parseNumericField(fields, 'CircleSize', 4));

  // Star rating + strains via rosu-pp-js
  let stars = 0;
  let bpm = 0;
  let strainValues = new Float64Array(0);
  let strainSectionMs = 400; // rosu-pp-js default
  let rosuBeatmap: RosuBeatmap | null = null;
  let difficulty: Difficulty | null = null;
  let diffAttrs: ReturnType<Difficulty['calculate']> | null = null;
  let strainsObj: Strains | null = null;

  try {
    rosuBeatmap = new RosuBeatmap(rawBeatmap);
    bpm = rosuBeatmap.bpm;

    if (mode === 3) {
      rosuBeatmap.convert(GameMode.Mania);
    }

    difficulty = new Difficulty();
    diffAttrs = difficulty.calculate(rosuBeatmap);
    stars = diffAttrs.stars;

    // Compute strain curve for the chart
    strainsObj = difficulty.strains(rosuBeatmap);
    strainSectionMs = strainsObj.sectionLength;

    // Pick the most relevant strain array for the mode
    const raw_strains: Float64Array | undefined =
      mode === 3
        ? strainsObj.strains // mania overall
        : mode === 1
          ? (strainsObj.stamina ?? strainsObj.strains) // taiko: stamina
          : (strainsObj.aim ?? strainsObj.strains); // std: aim, fallback overall

    if (raw_strains) {
      strainValues = new Float64Array(raw_strains);
    }
  } finally {
    // Free all WASM-backed objects immediately — their memory lives on the WASM
    // linear heap which doesn't shrink, so returning allocations promptly matters.
    strainsObj?.free();
    diffAttrs?.free();
    difficulty?.free();
    rosuBeatmap?.free();
  }

  // Parse mode-specific hit objects and timing data for rendering
  const notes = mode === 3 ? parseManiaObjects(rawBeatmap, keys) : [];
  const svPoints =
    mode === 3 || mode === 1 ? parseTimingPoints(rawBeatmap) : [];
  const timingPoints = mode === 1 ? parseUninheritedPoints(rawBeatmap) : [];
  const sliderMultiplier = parseNumericField(fields, 'SliderMultiplier', 1.4);
  const taikoNotes =
    mode === 1
      ? parseTaikoObjects(rawBeatmap, timingPoints, svPoints, sliderMultiplier)
      : [];

  const objects: Array<{ startTime: number; endTime: number }> =
    mode === 1
      ? taikoNotes
      : notes.length > 0
        ? notes
        : parseAllTimings(rawBeatmap);

  let firstObjectMs = 0;
  let lastObjectMs = 0;
  if (objects.length > 0) {
    firstObjectMs = objects[0]?.startTime ?? 0;
    for (const obj of objects) {
      if (obj.endTime > lastObjectMs) lastObjectMs = obj.endTime;
    }
  }

  const drainSeconds = computeDrainSeconds(
    rawBeatmap,
    firstObjectMs,
    lastObjectMs,
  );
  const strainStartMs =
    objects.length > 0
      ? computeStrainStartMs(firstObjectMs, strainSectionMs)
      : 0;

  return {
    title,
    titleUnicode,
    artist,
    artistUnicode,
    creator,
    version,
    mode,
    keys,
    hp,
    od,
    ar,
    stars,
    drainSeconds,
    bpm,
    notes,
    taikoNotes,
    timingPoints,
    firstObjectMs,
    lastObjectMs,
    strainValues,
    strainSectionMs,
    strainStartMs,
    svPoints,
  };
}

/**
 * Parses inherited timing points (green lines) from [TimingPoints] and
 * returns SV control points for mania rendering.
 *
 * Inherited points have uninherited === 0. Their beatLength encodes the SV
 * multiplier as a negative inverse percentage: svMultiplier = -100 / beatLength.
 * e.g. beatLength = -50  → svMultiplier = 2.0 (notes move 2× faster)
 *      beatLength = -200 → svMultiplier = 0.5 (notes move at half speed)
 */
function parseTimingPoints(raw: string): SvPoint[] {
  const section = raw.split(/^\[TimingPoints\]/m)[1]?.split(/^\[/m)[0];
  if (!section) return [];

  const points: SvPoint[] = [];
  let sorted = true;
  let previousTime = Number.NEGATIVE_INFINITY;

  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('[')) break;

    const parts = trimmed.split(',');
    if (parts.length < 8) continue;

    const time = parseFloat(parts[0] ?? '0');
    const beatLength = parseFloat(parts[1] ?? '0');
    const uninherited = parseInt(parts[6] ?? '1', 10);

    if (
      Number.isNaN(time) ||
      Number.isNaN(beatLength) ||
      Number.isNaN(uninherited)
    ) {
      continue;
    }

    // Only inherited (green) lines carry SV info. uninherited === 0 = green line.
    if (uninherited !== 0) continue;
    // beatLength must be negative for a valid inherited point
    if (beatLength >= 0) continue;

    const svMultiplier = Math.max(0.01, -100 / beatLength);
    if (time < previousTime) {
      sorted = false;
    }
    previousTime = time;
    points.push({ time, svMultiplier });
  }

  if (!sorted) {
    points.sort((a, b) => a.time - b.time);
  }
  return points;
}

/** Minimal timing-only parse for non-mania maps (to compute drain time) */
function parseAllTimings(raw: string): ManiaNote[] {
  const hitObjectsSection = raw.split(/^\[HitObjects\]/m)[1];
  if (!hitObjectsSection) return [];

  const timings: ManiaNote[] = [];
  for (const line of hitObjectsSection.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('[')) break;
    const parts = trimmed.split(',');
    if (parts.length < 3) continue;
    const startTime = parseInt(parts[2] ?? '0', 10);
    if (!Number.isNaN(startTime)) {
      timings.push({ column: 0, startTime, endTime: startTime, isHold: false });
    }
  }
  return timings;
}

/** Format seconds as mm:ss */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
