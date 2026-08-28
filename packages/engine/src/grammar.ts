import { CATALOG, MOVES_BY_ID } from './catalog';
import type { Intensity, Move, WorkoutConfig } from './types';

// ---------------------------------------------------------------------------
// Intensity parameters — the main "feel" tuning surface (M3 sprint).
// ---------------------------------------------------------------------------
export interface IntensityParams {
  minLen: number;
  maxLen: number;
  /** Average silence between callouts in a round. Smaller = denser. */
  gapSeconds: number;
  /** Probability a combo opens with a lead-side setup. */
  leadOpeningBias: number;
  /** Estimated seconds per strike inside a spoken combo. */
  strikeSeconds: number;
}

export const INTENSITY_PARAMS: Record<Intensity, IntensityParams> = {
  easy: { minLen: 2, maxLen: 4, gapSeconds: 8, leadOpeningBias: 0.8, strikeSeconds: 0.9 },
  moderate: { minLen: 2, maxLen: 5, gapSeconds: 6, leadOpeningBias: 0.75, strikeSeconds: 0.75 },
  hard: { minLen: 2, maxLen: 6, gapSeconds: 4.5, leadOpeningBias: 0.7, strikeSeconds: 0.6 },
};

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic workouts.
// ---------------------------------------------------------------------------
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick<T>(rng: Rng, items: T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= Math.max(0, weight(item));
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Combo grammar: role templates + constrained fill.
// ---------------------------------------------------------------------------
type SlotRole = 'open' | 'power' | 'any' | 'finisher';

// Role filters. 'open' resolves at fill time via leadOpeningBias: lead setup
// strike with probability `bias`, any strike otherwise (the ~30% counters).
function roleCandidates(role: SlotRole, strikes: Move[]): Move[] {
  switch (role) {
    case 'open':
      return strikes;
    case 'power':
      return strikes.filter((m) => m.power === 'power');
    case 'any':
      return strikes;
    case 'finisher':
      return strikes.filter((m) => m.power === 'power' && m.type !== 'punch');
  }
}

// Gym-lifted archetypes. Weighted per template; length filtered by intensity.
const TEMPLATES: { slots: SlotRole[]; weight: number }[] = [
  { slots: ['open', 'power'], weight: 2 },
  { slots: ['open', 'power', 'power'], weight: 3 },
  { slots: ['open', 'power', 'finisher'], weight: 3 },
  { slots: ['open', 'power', 'power', 'finisher'], weight: 3 },
  { slots: ['open', 'power', 'any', 'power'], weight: 2 },
  { slots: ['open', 'finisher'], weight: 1 },
  { slots: ['open', 'power', 'power', 'power', 'finisher'], weight: 1.5 },
  { slots: ['open', 'power', 'any', 'power', 'finisher'], weight: 1.5 },
  { slots: ['open', 'power', 'power', 'power', 'power', 'finisher'], weight: 0.5 },
];

const MAX_RETRIES = 8;
const ALLOWED_REPEATS = new Set(['jab', 'lead-teep', 'rear-teep']);

/** Transition constraint: can `next` follow `prev`? */
function canFollow(prev: Move, next: Move): boolean {
  // Same-side power chains are unnatural — except trained doubles (jab, teep).
  if (prev.power === 'power' && next.power === 'power' && prev.side === next.side) {
    return false;
  }
  // Same-side kick into kick ignores rotation/recovery.
  if (prev.type === 'kick' && next.type === 'kick' && prev.side === next.side) {
    return false;
  }
  // Identical power strikes back to back (e.g. cross-cross) also fail above;
  // identical light strikes only allowed for trained doubles.
  if (prev.id === next.id && next.power === 'power') {
    return false;
  }
  return true;
}

function validateCombo(moveIds: string[]): boolean {
  for (let i = 0; i < moveIds.length; i++) {
    const move = MOVES_BY_ID.get(moveIds[i]);
    if (!move) return false;
    if (i > 0) {
      const prev = MOVES_BY_ID.get(moveIds[i - 1])!;
      if (!canFollow(prev, move)) return false;
      if (prev.id === move.id && !ALLOWED_REPEATS.has(move.id)) return false;
    }
  }
  return true;
}

function enabledStrikes(config: WorkoutConfig): Move[] {
  const disabled = new Set(config.disabledMoveIds);
  return CATALOG.filter((m) => isStrike(m) && !disabled.has(m.id));
}

function isStrike(move: Move): boolean {
  return move.type === 'punch' || move.type === 'kick' || move.type === 'knee' || move.type === 'elbow';
}

function isSetup(move: Move): boolean {
  return move.side === 'lead' && move.power === 'light';
}

/**
 * Generate one combo. Bounded retries with fresh rng draws; falls back to a
 * minimal [setup, opposite-side power] combo when constraints are tight
 * (e.g. very few enabled moves).
 */
export function generateCombo(rng: Rng, params: IntensityParams, strikes: Move[]): string[] {
  if (strikes.length === 0) return [];

  const usable = TEMPLATES.filter(
    (t) => t.slots.length >= params.minLen && t.slots.length <= params.maxLen,
  );
  const templates = usable.length > 0 ? usable : TEMPLATES.slice(0, 1);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const template = weightedPick(rng, templates, (t) => t.weight);
    const combo: Move[] = [];
    let ok = true;

    for (const role of template.slots) {
      let candidates = roleCandidates(role, strikes);
      if (role === 'open' && rng() < params.leadOpeningBias) {
        const setups = candidates.filter(isSetup);
        if (setups.length > 0) candidates = setups;
      }
      if (combo.length > 0) {
        const prev = combo[combo.length - 1];
        const following = candidates.filter((m) => canFollow(prev, m) && (m.id !== prev.id || ALLOWED_REPEATS.has(m.id)));
        if (following.length > 0) candidates = following;
        else {
          ok = false;
          break;
        }
      }
      if (candidates.length === 0) {
        ok = false;
        break;
      }
      combo.push(weightedPick(rng, candidates, () => 1));
    }

    if (ok && combo.length >= 2 && validateCombo(combo.map((m) => m.id))) {
      return combo.map((m) => m.id);
    }
  }

  return fallbackCombo(strikes);
}

function fallbackCombo(strikes: Move[]): string[] {
  if (strikes.length === 1) return [strikes[0].id, strikes[0].id];
  const setup = strikes.find(isSetup) ?? strikes[0];
  const partner =
    strikes.find((m) => m.id !== setup.id && canFollow(setup, m)) ??
    strikes.find((m) => m.id !== setup.id)!;
  return [setup.id, partner.id];
}

/** Convenience for tests and callers wanting N combos from one seed. */
export function generateCombos(config: WorkoutConfig, count: number): string[][] {
  const rng = createRng(config.seed);
  const params = INTENSITY_PARAMS[config.intensity];
  const strikes = enabledStrikes(config);
  const combos: string[][] = [];
  for (let i = 0; i < count; i++) combos.push(generateCombo(rng, params, strikes));
  return combos;
}

/** Pick a defense/movement cue (single-move events, never inside combos). */
export function pickCue(rng: Rng, config: WorkoutConfig): string | null {
  const disabled = new Set(config.disabledMoveIds);
  const cues = CATALOG.filter(
    (m) => (m.type === 'defense' || m.type === 'movement') && !disabled.has(m.id),
  );
  if (cues.length === 0) return null;
  return weightedPick(rng, cues, () => 1).id;
}
