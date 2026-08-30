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

// ---------------------------------------------------------------------------
// Range rules — elbows close the distance; 'back' is the voiced step-out.
// ---------------------------------------------------------------------------
const CLINCH_TYPES = new Set(['elbow', 'knee']);
const HOOK_IDS = new Set(['lead-hook', 'rear-hook']);
const TEEP_IDS = new Set(['lead-teep', 'rear-teep']);
const STEP_BACK_ID = 'step-back';

/** Probability the voiced step-out is inserted after an elbow (tuning knob). */
const BACK_EXIT_CHANCE = 0.4;

// Rarity weights — affect draw probability only, never legality.
const ELBOW_HOOK_WEIGHT = 0.15;
const KNEE_KICK_WEIGHT = 0.35;
const KNEE_TEEP_WEIGHT = 0.1;

export interface ComboOptions {
  /** Whether 'step-back' may be inserted as a voiced exit after elbows. */
  backEnabled: boolean;
}

/** Transition constraint: can `next` follow `prev`? */
function canFollow(prev: Move, next: Move): boolean {
  // The step-out exits only the elbow lock, and you don't step straight
  // back in (or out again) immediately after stepping out.
  if (prev.id === STEP_BACK_ID) {
    return next.id !== STEP_BACK_ID && next.type !== 'elbow';
  }
  if (next.id === STEP_BACK_ID) {
    return prev.type === 'elbow';
  }
  // Elbow lock: once in close, only clinch strikes or a short hook follow.
  if (prev.type === 'elbow' && !CLINCH_TYPES.has(next.type) && !HOOK_IDS.has(next.id)) {
    return false;
  }
  // Same-side power chains are unnatural — except trained doubles (jab, teep)
  // and clinch chains, where rotation carries through in close.
  const clinchChain = CLINCH_TYPES.has(prev.type) && CLINCH_TYPES.has(next.type);
  if (
    prev.power === 'power' &&
    next.power === 'power' &&
    prev.side === next.side &&
    !clinchChain
  ) {
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

/** Draw weight for `next` given `prev` — rarity tuning, never legality. */
function candidateWeight(prev: Move | null, next: Move): number {
  if (!prev) return 1;
  if (prev.type === 'elbow' && HOOK_IDS.has(next.id)) return ELBOW_HOOK_WEIGHT;
  if (prev.type === 'knee') {
    if (TEEP_IDS.has(next.id)) return KNEE_TEEP_WEIGHT;
    if (next.type === 'kick') return KNEE_KICK_WEIGHT;
  }
  return 1;
}

/**
 * Generate one combo. Bounded retries with fresh rng draws; falls back to a
 * minimal [setup, opposite-side power] combo when constraints are tight
 * (e.g. very few enabled moves).
 */
export function generateCombo(
  rng: Rng,
  params: IntensityParams,
  strikes: Move[],
  options: ComboOptions = { backEnabled: true },
): string[] {
  if (strikes.length === 0) return [];

  const stepBack = MOVES_BY_ID.get(STEP_BACK_ID)!;
  const usable = TEMPLATES.filter(
    (t) => t.slots.length >= params.minLen && t.slots.length <= params.maxLen,
  );
  const templates = usable.length > 0 ? usable : TEMPLATES.slice(0, 1);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const template = weightedPick(rng, templates, (t) => t.weight);
    const combo: Move[] = [];
    let backUsed = false;
    let ok = true;

    for (let slot = 0; slot < template.slots.length; slot++) {
      const role = template.slots[slot];
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
      const prev = combo.length > 0 ? combo[combo.length - 1] : null;
      combo.push(weightedPick(rng, candidates, (m) => candidateWeight(prev, m)));

      // Free 'back' exit after an elbow — spoken step-out, no slot consumed.
      if (
        options.backEnabled &&
        !backUsed &&
        combo[combo.length - 1].type === 'elbow' &&
        slot < template.slots.length - 1 &&
        rng() < BACK_EXIT_CHANCE
      ) {
        combo.push(stepBack);
        backUsed = true;
      }
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
  const options: ComboOptions = { backEnabled: !config.disabledMoveIds.includes(STEP_BACK_ID) };
  const combos: string[][] = [];
  for (let i = 0; i < count; i++) combos.push(generateCombo(rng, params, strikes, options));
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
