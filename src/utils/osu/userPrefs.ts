/**
 * Per-user preferences for note rendering.
 * Stored in memory with write-through to Redis; persists across restarts.
 */

export type NoteStyle = 'bar' | 'circle' | 'arrow';

/**
 * How to choose the render window for maps longer than 4 minutes.
 * - 'last4min': render the final 4 minutes of the map (default)
 * - 'preview':  centre the 4-minute window on the beatmap's preview point,
 *               clamped so the window never extends beyond the map's notes
 */
export type RenderMode = 'last4min' | 'preview';

/**
 * Which direction notes travel toward the hit line.
 * - 'down': notes fall downward (hit line at bottom) — default, matches osu!mania
 * - 'up':   notes rise upward (hit line at top)
 */
export type ScrollDirection = 'down' | 'up';

export const NOTE_STYLE_DEFAULT: NoteStyle = 'bar';
export const RENDER_MODE_DEFAULT: RenderMode = 'last4min';
export const SCROLL_DIRECTION_DEFAULT: ScrollDirection = 'down';
export const STRAIN_OVERLAY_DEFAULT = true;

/** Default note colors — alternating blue/white with yellow for centre column */
export const NOTE_COLORS_DEFAULT = ['#00aaff', '#ffffff', '#00aaff', '#ffffff'];
export const NOTE_COLOR_SPECIAL_DEFAULT = '#ffdd00';

export interface UserPrefs {
  noteStyle: NoteStyle;
  /** Per-column colors — up to 4 entries, used modulo */
  noteColors: string[];
  /** Center-column special color (odd-key maps) */
  noteColorSpecial: string;
  /** How to pick the render window for long maps */
  renderMode: RenderMode;
  /** Which direction notes travel toward the hit line */
  scrollDirection: ScrollDirection;
  /** Whether to show the strain footer overlay in rendered previews */
  strainOverlay: boolean;
}

const userPrefs = new Map<string, UserPrefs>();
const redisCacheMisses = new Set<string>();

async function loadUserPrefsFromRedis(
  userId: string,
): Promise<UserPrefs | null> {
  if (redisCacheMisses.has(userId)) {
    return null;
  }

  try {
    const { getUserPrefsFromRedis } = await import('@/queue/store');
    const prefs = await getUserPrefsFromRedis(userId);
    if (prefs === null) {
      redisCacheMisses.add(userId);
    }
    return prefs;
  } catch (_error) {
    return null;
  }
}

function defaultPrefs(): UserPrefs {
  return {
    noteStyle: NOTE_STYLE_DEFAULT,
    noteColors: [...NOTE_COLORS_DEFAULT],
    noteColorSpecial: NOTE_COLOR_SPECIAL_DEFAULT,
    renderMode: RENDER_MODE_DEFAULT,
    scrollDirection: SCROLL_DIRECTION_DEFAULT,
    strainOverlay: STRAIN_OVERLAY_DEFAULT,
  };
}

export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const cached = userPrefs.get(userId);
  if (cached) return cached;

  const fromRedis = await loadUserPrefsFromRedis(userId);
  if (fromRedis) {
    userPrefs.set(userId, fromRedis);
    return fromRedis;
  }

  const defaults = defaultPrefs();
  userPrefs.set(userId, defaults);
  return defaults;
}

function ensureUser(userId: string): UserPrefs {
  let prefs = userPrefs.get(userId);
  if (!prefs) {
    prefs = defaultPrefs();
    userPrefs.set(userId, prefs);
  }
  return prefs;
}

export async function setNoteStyle(
  userId: string,
  style: NoteStyle,
): Promise<void> {
  const prefs = ensureUser(userId);
  prefs.noteStyle = style;
  redisCacheMisses.delete(userId);

  try {
    const { setUserPrefsFieldToRedis } = await import('@/queue/store');
    await setUserPrefsFieldToRedis(userId, 'noteStyle', style);
  } catch (_error) {}
}

/**
 * Set a note color for a specific column index (0-based).
 * Pass `'special'` as colIndex to set the center-column color.
 */
export async function setNoteColor(
  userId: string,
  colIndex: number | 'special',
  hex: string,
): Promise<void> {
  const prefs = ensureUser(userId);
  let field: 'noteColors' | 'noteColorSpecial' = 'noteColors';
  let value = '';

  if (colIndex === 'special') {
    prefs.noteColorSpecial = hex;
    field = 'noteColorSpecial';
    value = hex;
  } else {
    prefs.noteColors[colIndex] = hex;
    value = JSON.stringify(prefs.noteColors);
  }
  redisCacheMisses.delete(userId);

  try {
    const { setUserPrefsFieldToRedis } = await import('@/queue/store');
    await setUserPrefsFieldToRedis(userId, field, value);
  } catch (_error) {}
}

export async function setRenderMode(
  userId: string,
  mode: RenderMode,
): Promise<void> {
  const prefs = ensureUser(userId);
  prefs.renderMode = mode;
  redisCacheMisses.delete(userId);

  try {
    const { setUserPrefsFieldToRedis } = await import('@/queue/store');
    await setUserPrefsFieldToRedis(userId, 'renderMode', mode);
  } catch (_error) {}
}

export async function setScrollDirection(
  userId: string,
  direction: ScrollDirection,
): Promise<void> {
  const prefs = ensureUser(userId);
  prefs.scrollDirection = direction;
  redisCacheMisses.delete(userId);

  try {
    const { setUserPrefsFieldToRedis } = await import('@/queue/store');
    await setUserPrefsFieldToRedis(userId, 'scrollDirection', direction);
  } catch (_error) {}
}

export async function setStrainOverlay(
  userId: string,
  enabled: boolean,
): Promise<void> {
  ensureUser(userId).strainOverlay = enabled;
  redisCacheMisses.delete(userId);

  try {
    const { setUserPrefsFieldToRedis } = await import('@/queue/store');
    await setUserPrefsFieldToRedis(
      userId,
      'strainOverlay',
      enabled ? '1' : '0',
    );
  } catch (_error) {}
}

/** Reset a user's preferences to defaults */
export async function resetUserPrefs(userId: string): Promise<void> {
  userPrefs.delete(userId);
  redisCacheMisses.delete(userId);

  try {
    const { deleteUserPrefsFromRedis } = await import('@/queue/store');
    await deleteUserPrefsFromRedis(userId);
  } catch (_error) {}
}
