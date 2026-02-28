/**
 * Per-user preferences for note rendering.
 * Stored in memory; resets on bot restart.
 */

export type NoteStyle = 'bar' | 'circle' | 'arrow';

/**
 * How to choose the render window for maps longer than 4 minutes.
 * - 'last4min': render the final 4 minutes of the map (default)
 * - 'preview':  centre the 4-minute window on the beatmap's preview point,
 *               clamped so the window never extends beyond the map's notes
 */
export type RenderMode = 'last4min' | 'preview';

export const NOTE_STYLE_DEFAULT: NoteStyle = 'bar';
export const RENDER_MODE_DEFAULT: RenderMode = 'last4min';

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
}

const userPrefs = new Map<string, UserPrefs>();

function defaultPrefs(): UserPrefs {
  return {
    noteStyle: NOTE_STYLE_DEFAULT,
    noteColors: [...NOTE_COLORS_DEFAULT],
    noteColorSpecial: NOTE_COLOR_SPECIAL_DEFAULT,
    renderMode: RENDER_MODE_DEFAULT,
  };
}

export function getUserPrefs(userId: string): UserPrefs {
  return userPrefs.get(userId) ?? defaultPrefs();
}

function ensureUser(userId: string): UserPrefs {
  let prefs = userPrefs.get(userId);
  if (!prefs) {
    prefs = defaultPrefs();
    userPrefs.set(userId, prefs);
  }
  return prefs;
}

export function setNoteStyle(userId: string, style: NoteStyle): void {
  ensureUser(userId).noteStyle = style;
}

/**
 * Set a note color for a specific column index (0-based).
 * Pass `'special'` as colIndex to set the center-column color.
 */
export function setNoteColor(
  userId: string,
  colIndex: number | 'special',
  hex: string,
): void {
  const prefs = ensureUser(userId);
  if (colIndex === 'special') {
    prefs.noteColorSpecial = hex;
  } else {
    prefs.noteColors[colIndex] = hex;
  }
}

export function setRenderMode(userId: string, mode: RenderMode): void {
  ensureUser(userId).renderMode = mode;
}

/** Reset a user's preferences to defaults */
export function resetUserPrefs(userId: string): void {
  userPrefs.delete(userId);
}
