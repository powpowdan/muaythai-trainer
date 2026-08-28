import { CATALOG } from './catalog';

/**
 * Text → clip filename slug. "one" → "one", "round three" → "round-three".
 */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Distinct spoken words for moves, derived from the catalog. Lead/rear
 * variants share one clip (both kicks are called "kick").
 */
export const MOVE_VOICE_TEXTS: string[] = [
  ...new Set(CATALOG.map((m) => m.calloutText)),
].sort();

const ROUND_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve',
];

/**
 * Fixed phrases the scheduler emits outside combos. Round announcements are
 * generated as single clips for natural prosody ("round three" as one breath).
 */
export const ANNOUNCEMENT_TEXTS: string[] = [
  ...ROUND_WORDS.map((w) => `round ${w}`),
  'rest',
  'time',
];

/** Everything the voice pipeline must generate, in stable order. */
export const VOICE_CLIP_TEXTS: string[] = [...MOVE_VOICE_TEXTS, ...ANNOUNCEMENT_TEXTS];
