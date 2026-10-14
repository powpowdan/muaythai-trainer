import { CATALOG, MOVES_BY_ID } from './catalog';
import type { Intensity, Move, WorkoutConfig } from './types';

// ---------------------------------------------------------------------------
// Intensity parameters — the main "feel" tuning surface (M3 sprint).
// ---------------------------------------------------------------------------
export interface IntensityParams {
  minLen: number;
  maxLen: number;
  /** Length cap for pure-boxing combos — punches chain faster than clinch work. */
  boxingMaxLen: number;
  /** Average silence between callouts in a round. Smaller = denser. */
  gapSeconds: number;
  /** Probability a combo opens with a lead-side setup. */
  leadOpeningBias: number;
  /** Estimated seconds per strike inside a spoken combo. */
  strikeSeconds: number;
}

export const INTENSITY_PARAMS: Record<Intensity, IntensityParams> = {
  easy: { minLen: 2, maxLen: 4, boxingMaxLen: 4, gapSeconds: 8, leadOpeningBias: 0.8, strikeSeconds: 0.9 },
  moderate: { minLen: 2, maxLen: 5, boxingMaxLen: 6, gapSeconds: 6, leadOpeningBias: 0.75, strikeSeconds: 0.75 },
  hard: { minLen: 2, maxLen: 6, boxingMaxLen: 6, gapSeconds: 4.5, leadOpeningBias: 0.7, strikeSeconds: 0.6 },
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
// Combo grammar: range-phase families + constrained fill.
//
// Every combo is a walk through space: box at range, finish with a kick
// (covers the exit, returns to range) or close in for clinch weapons.
// ---------------------------------------------------------------------------
type ComboFamily = 'boxing' | 'box-kick' | 'close' | 'range';
type SlotRole = 'punch' | 'kick' | 'clinch' | 'rangeLight';

// Family mix (tuning surface): boxing ~30%, box-kick ~35%, close ~25%, range ~10%.
const FAMILY_WEIGHTS: Record<ComboFamily, number> = {
  boxing: 3.0,
  'box-kick': 3.5,
  close: 2.5,
  range: 1.0,
};

// Templates per family. First slot resolves to the family's chain role
// ('punch', or 'rangeLight' for range) under the lead-opening bias; the
// close family's standard entries carry a >=2-punch prefix before clinch
// slots so closing reads as a deliberate step in, not a teleport.
const TEMPLATES: { family: ComboFamily; slots: SlotRole[]; weight: number }[] = [
  // Boxing: punch-only chains; jab chainable anywhere (1-2, 1-2-3, 1-2-1-2…)
  { family: 'boxing', slots: ['punch', 'punch'], weight: 2 },
  { family: 'boxing', slots: ['punch', 'punch', 'punch'], weight: 3 },
  { family: 'boxing', slots: ['punch', 'punch', 'punch', 'punch'], weight: 2.5 },
  { family: 'boxing', slots: ['punch', 'punch', 'punch', 'punch', 'punch'], weight: 1.5 },
  { family: 'boxing', slots: ['punch', 'punch', 'punch', 'punch', 'punch', 'punch'], weight: 1 },
  // Box-kick: punch chain into a kick finish that resets the range
  { family: 'box-kick', slots: ['punch', 'kick'], weight: 1 },
  { family: 'box-kick', slots: ['punch', 'punch', 'kick'], weight: 3 },
  { family: 'box-kick', slots: ['punch', 'punch', 'punch', 'kick'], weight: 3 },
  { family: 'box-kick', slots: ['punch', 'punch', 'punch', 'punch', 'kick'], weight: 1.5 },
  { family: 'box-kick', slots: ['punch', 'punch', 'punch', 'punch', 'punch', 'kick'], weight: 1 },
  // Close: punches in, clinch weapons finish; hook-out after; rare direct entry
  { family: 'close', slots: ['punch', 'punch', 'clinch'], weight: 3 },
  { family: 'close', slots: ['punch', 'punch', 'punch', 'clinch'], weight: 2.5 },
  { family: 'close', slots: ['punch', 'punch', 'punch', 'punch', 'clinch'], weight: 1 },
  { family: 'close', slots: ['punch', 'punch', 'punch', 'punch', 'punch', 'clinch'], weight: 0.5 },
  { family: 'close', slots: ['punch', 'punch', 'clinch', 'clinch'], weight: 1.75 },
  { family: 'close', slots: ['punch', 'punch', 'punch', 'clinch', 'clinch'], weight: 1.75 },
  { family: 'close', slots: ['punch', 'punch', 'clinch', 'punch'], weight: 0.5 },
  { family: 'close', slots: ['punch', 'clinch'], weight: 0.3 },
  // Range: jab/teep play — feints, range breaks, single-leg pokes
  { family: 'range', slots: ['rangeLight', 'rangeLight'], weight: 2 },
  { family: 'range', slots: ['rangeLight', 'rangeLight', 'rangeLight'], weight: 1 },
];

/** Which slot roles can open each family's chain. */
const FAMILY_CHAIN_ROLE: Record<ComboFamily, SlotRole> = {
  boxing: 'punch',
  'box-kick': 'punch',
  close: 'punch',
  range: 'rangeLight',
};

function roleCandidates(role: SlotRole, strikes: Move[]): Move[] {
  switch (role) {
    case 'punch':
      return strikes.filter((m) => m.type === 'punch');
    case 'kick':
      return strikes.filter((m) => m.type === 'kick' && m.power === 'power');
    case 'clinch':
      return strikes.filter((m) => m.type === 'knee' || m.type === 'elbow');
    case 'rangeLight':
      return strikes.filter(
        (m) => (m.type === 'punch' && m.power === 'light') || TEEP_IDS.has(m.id),
      );
  }
}

// Role draw weights — rhythm tuning, never legality.
const DOUBLE_JAB_WEIGHT = 0.4;
const JAB_CHAIN_WEIGHT = 0.8;
const TEEP_RANGE_WEIGHT = 0.8;
const ELBOW_CLINCH_WEIGHT = 0.35;

function roleWeight(role: SlotRole, move: Move): number {
  switch (role) {
    case 'punch':
      if (move.id === 'double-jab') return DOUBLE_JAB_WEIGHT;
      if (move.id === 'jab') return JAB_CHAIN_WEIGHT;
      return 1;
    case 'kick':
      return 1;
    case 'clinch':
      return move.type === 'elbow' ? ELBOW_CLINCH_WEIGHT : 1;
    case 'rangeLight':
      if (move.id === 'double-jab') return DOUBLE_JAB_WEIGHT;
      if (TEEP_IDS.has(move.id)) return TEEP_RANGE_WEIGHT;
      return 1;
  }
}

const MAX_RETRIES = 8;
// Trained same-move repeats. Jab is NOT here: a doubled jab is the
// 'double-jab' unit, never two raw jabs.
const ALLOWED_REPEATS = new Set(['lead-teep', 'rear-teep']);

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
  // The step-out exits only the elbow lock into range work: no second
  // step-out, no elbow, and no knee (you just gave the ground back).
  if (prev.id === STEP_BACK_ID) {
    return next.id !== STEP_BACK_ID && next.type !== 'elbow' && next.type !== 'knee';
  }
  if (next.id === STEP_BACK_ID) {
    return prev.type === 'elbow';
  }
  // Elbow lock: once in close, only clinch strikes or a short hook follow.
  if (prev.type === 'elbow' && !CLINCH_TYPES.has(next.type) && !HOOK_IDS.has(next.id)) {
    return false;
  }
  // Same-side power chains are unnatural — except trained doubles (teep)
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
  // Identical strikes back to back only for trained repeats (teeps); a
  // doubled jab is the 'double-jab' unit, and two units make a quad.
  if (prev.id === next.id) {
    return ALLOWED_REPEATS.has(next.id);
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
 * Generate one combo. Family first (the mix dial), then a template within
 * the family, then constrained fill. Bounded retries with fresh rng draws;
 * falls back to a minimal [setup, opposite-side power] combo when
 * constraints are tight (e.g. very few enabled moves).
 */
export function generateCombo(
  rng: Rng,
  params: IntensityParams,
  strikes: Move[],
  options: ComboOptions = { backEnabled: true },
): string[] {
  if (strikes.length === 0) return [];

  const stepBack = MOVES_BY_ID.get(STEP_BACK_ID)!;
  const usable = TEMPLATES.filter((t) => {
    const cap = t.family === 'boxing' ? params.boxingMaxLen : params.maxLen;
    return t.slots.length >= params.minLen && t.slots.length <= cap;
  });
  const templates = usable.length > 0 ? usable : TEMPLATES.slice(0, 1);
  const families = Object.keys(FAMILY_WEIGHTS) as ComboFamily[];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const family = weightedPick(rng, families, (f) => {
      const available = templates.some((t) => t.family === f);
      return available ? FAMILY_WEIGHTS[f] : 0;
    });
    const familyTemplates = templates.filter((t) => t.family === family);
    const template = weightedPick(rng, familyTemplates, (t) => t.weight);
    const chainRole = FAMILY_CHAIN_ROLE[family];
    const combo: Move[] = [];
    let backUsed = false;
    let ok = true;

    for (let slot = 0; slot < template.slots.length; slot++) {
      const role = slot === 0 ? chainRole : template.slots[slot];
      let candidates = roleCandidates(role, strikes);
      // First slot honors the lead-opening bias (counters bypass it).
      if (slot === 0 && rng() < params.leadOpeningBias) {
        const setups = candidates.filter(isSetup);
        if (setups.length > 0) candidates = setups;
      }
      if (combo.length > 0) {
        const prev = combo[combo.length - 1];
        const following = candidates.filter((m) => canFollow(prev, m));
        if (following.length === 0) {
          ok = false;
          break;
        }
        candidates = following;
      }
      if (candidates.length === 0) {
        ok = false;
        break;
      }
      const prev = combo.length > 0 ? combo[combo.length - 1] : null;
      combo.push(weightedPick(rng, candidates, (m) => roleWeight(role, m) * candidateWeight(prev, m)));

      // Free 'back' exit after an elbow — spoken step-out, no slot consumed.
      // Only offered when range work resumes next (never before another
      // clinch slot): stepping out and immediately clinching again reads
      // as a teleport.
      if (
        options.backEnabled &&
        !backUsed &&
        combo[combo.length - 1].type === 'elbow' &&
        slot < template.slots.length - 1 &&
        template.slots[slot + 1] !== 'clinch' &&
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
  if (strikes.length === 1) {
    const only = strikes[0];
    // A lone jab cannot pair with itself — doubling is the unit's job.
    // Degenerate config: emit a single-move callout and let the caller cope.
    if (only.id === 'jab') return ['jab'];
    return [only.id, only.id];
  }
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
