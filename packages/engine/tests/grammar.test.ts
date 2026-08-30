import { describe, expect, it } from 'vitest';
import { generateCombos, INTENSITY_PARAMS } from '../src/grammar';
import { MOVES_BY_ID } from '../src/catalog';
import type { WorkoutConfig } from '../src/types';

const STRIKE_TYPES = new Set(['punch', 'kick', 'knee', 'elbow']);

function config(partial: Partial<WorkoutConfig> = {}): WorkoutConfig {
  return {
    rounds: 3,
    roundSeconds: 180,
    restSeconds: 60,
    intensity: 'moderate',
    disabledMoveIds: [],
    seed: 42,
    ...partial,
  };
}

function combosFor(partial: Partial<WorkoutConfig>, count = 60): string[][] {
  return generateCombos(config(partial), count);
}

describe('grammar: config respect', () => {
  it('never uses a disabled move, checked for every catalog move', () => {
    for (const move of MOVES_BY_ID.values()) {
      const combos = combosFor({ disabledMoveIds: [move.id], seed: move.id.length * 7919 });
      for (const combo of combos) {
        expect(combo, `disabled move ${move.id} leaked`).not.toContain(move.id);
      }
    }
  });

  it('only emits catalog moves that are strikes, plus the step-out', () => {
    for (const combo of combosFor({}, 80)) {
      expect(combo.length).toBeGreaterThan(0);
      for (const id of combo) {
        const move = MOVES_BY_ID.get(id);
        expect(move, `unknown move id ${id}`).toBeTruthy();
        const allowed = STRIKE_TYPES.has(move!.type) || id === 'step-back';
        expect(allowed, `${id} is not a strike or the step-out`).toBe(true);
      }
    }
  });
});

describe('grammar: naturalness invariants', () => {
  const intensities = ['easy', 'moderate', 'hard'] as const;

  it('no consecutive same-side power strikes (any combo, any intensity)', () => {
    for (const intensity of intensities) {
      for (const combo of combosFor({ intensity }, 80)) {
        for (let i = 1; i < combo.length; i++) {
          const prev = MOVES_BY_ID.get(combo[i - 1])!;
          const curr = MOVES_BY_ID.get(combo[i])!;
          const clinchChain =
            (prev.type === 'elbow' || prev.type === 'knee') &&
            (curr.type === 'elbow' || curr.type === 'knee');
          const bothPowerSameSide =
            prev.power === 'power' && curr.power === 'power' && prev.side === curr.side && !clinchChain;
          expect(
            bothPowerSameSide,
            `${intensity}: ${combo.join('-')} has ${prev.id} then ${curr.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it('no kick immediately followed by a same-side kick', () => {
    for (const intensity of intensities) {
      for (const combo of combosFor({ intensity }, 80)) {
        for (let i = 1; i < combo.length; i++) {
          const prev = MOVES_BY_ID.get(combo[i - 1])!;
          const curr = MOVES_BY_ID.get(combo[i])!;
          const sameSideKickKick =
            prev.type === 'kick' && curr.type === 'kick' && prev.side === curr.side;
          expect(sameSideKickKick, `${intensity}: ${combo.join('-')}`).toBe(false);
        }
      }
    }
  });

  it('at least 70% of combos open lead or neutral', () => {
    for (const intensity of intensities) {
      const combos = combosFor({ intensity }, 60);
      const leadOpens = combos.filter((c) => {
        const first = MOVES_BY_ID.get(c[0])!;
        return first.side !== 'rear';
      }).length;
      expect(
        leadOpens / combos.length,
        `${intensity}: only ${leadOpens}/${combos.length} open lead/neutral`,
      ).toBeGreaterThanOrEqual(0.7);
    }
  });
});

describe('grammar: intensity scaling', () => {
  const capByIntensity = { easy: 4, moderate: 5, hard: 6 } as const;

  it('easy combos are 2-4 strikes (2-5 with a step-out)', () => {
    for (const combo of combosFor({ intensity: 'easy' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(capByIntensity.easy + (combo.includes('step-back') ? 1 : 0));
    }
  });

  it('moderate combos are 2-5 strikes (2-6 with a step-out)', () => {
    for (const combo of combosFor({ intensity: 'moderate' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(capByIntensity.moderate + (combo.includes('step-back') ? 1 : 0));
    }
  });

  it('hard combos are 2-6 strikes (2-7 with a step-out)', () => {
    for (const combo of combosFor({ intensity: 'hard' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(capByIntensity.hard + (combo.includes('step-back') ? 1 : 0));
    }
  });

  it('rest gaps shrink as intensity rises (monotonic callout density)', () => {
    expect(INTENSITY_PARAMS.easy.gapSeconds).toBeGreaterThan(INTENSITY_PARAMS.moderate.gapSeconds);
    expect(INTENSITY_PARAMS.moderate.gapSeconds).toBeGreaterThan(INTENSITY_PARAMS.hard.gapSeconds);
  });
});

describe('grammar: determinism', () => {
  it('same seed produces identical combos', () => {
    const a = combosFor({ seed: 1234 }, 40);
    const b = combosFor({ seed: 1234 }, 40);
    expect(a).toEqual(b);
  });
});

describe('grammar: range rules', () => {
  const intensities = ['easy', 'moderate', 'hard'] as const;
  const isHook = (id: string) => id === 'lead-hook' || id === 'rear-hook';
  const isClinchType = (type: string) => type === 'elbow' || type === 'knee';

  it('no non-hook punch, kick, or teep immediately after an elbow', () => {
    for (const intensity of intensities) {
      for (const combo of combosFor({ intensity }, 120)) {
        for (let i = 1; i < combo.length; i++) {
          const prev = MOVES_BY_ID.get(combo[i - 1])!;
          if (prev.type !== 'elbow') continue;
          const curr = MOVES_BY_ID.get(combo[i])!;
          const allowed =
            isClinchType(curr.type) || isHook(curr.id) || curr.id === 'step-back';
          expect(allowed, `${intensity}: ${combo.join('-')} has ${prev.id} then ${curr.id}`).toBe(true);
        }
      }
    }
  });

  it("'back' only follows an elbow, at most once, never a shuffle", () => {
    for (const intensity of intensities) {
      for (const combo of combosFor({ intensity }, 120)) {
        expect(combo[0], combo.join('-')).not.toBe('step-back');
        expect(combo.filter((id) => id === 'step-back').length, combo.join('-')).toBeLessThanOrEqual(1);
        for (let i = 1; i < combo.length; i++) {
          if (combo[i] !== 'step-back') continue;
          const prev = MOVES_BY_ID.get(combo[i - 1])!;
          expect(prev.type, combo.join('-')).toBe('elbow');
          if (i + 1 < combo.length) {
            const next = MOVES_BY_ID.get(combo[i + 1])!;
            expect(next.id, combo.join('-')).not.toBe('step-back');
            expect(next.type, combo.join('-')).not.toBe('elbow');
          }
        }
      }
    }
  });

  it('never inserts back when step-back is disabled', () => {
    for (const intensity of intensities) {
      for (const combo of combosFor({ intensity, disabledMoveIds: ['step-back'] }, 80)) {
        expect(combo.includes('step-back'), intensity).toBe(false);
      }
    }
  });

  it('clinch chains remain reachable: elbow→elbow, elbow→knee, same-side clinch, knee→punch', () => {
    let elbowElbow = false;
    let elbowKnee = false;
    let sameSideClinch = false;
    let kneePunch = false;
    for (let seed = 1; seed <= 300 && !(elbowElbow && elbowKnee && sameSideClinch && kneePunch); seed++) {
      for (const combo of combosFor({ seed, intensity: 'hard' }, 20)) {
        for (let i = 1; i < combo.length; i++) {
          const prev = MOVES_BY_ID.get(combo[i - 1])!;
          const curr = MOVES_BY_ID.get(combo[i])!;
          if (prev.type === 'elbow' && curr.type === 'elbow') elbowElbow = true;
          if (prev.type === 'elbow' && curr.type === 'knee') elbowKnee = true;
          if (
            prev.power === 'power' && curr.power === 'power' &&
            prev.side === curr.side && prev.id !== curr.id &&
            isClinchType(prev.type) && isClinchType(curr.type)
          ) sameSideClinch = true;
          if (prev.type === 'knee' && curr.type === 'punch') kneePunch = true;
        }
      }
    }
    expect(elbowElbow, 'elbow→elbow never generated').toBe(true);
    expect(elbowKnee, 'elbow→knee never generated').toBe(true);
    expect(sameSideClinch, 'same-side clinch chain never generated').toBe(true);
    expect(kneePunch, 'knee→punch never generated').toBe(true);
  });

  it('hooks after elbows are rare (under 15%)', () => {
    let postElbow = 0;
    let hooks = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const combo of combosFor({ seed, intensity: 'hard' }, 20)) {
        for (let i = 1; i < combo.length; i++) {
          if (MOVES_BY_ID.get(combo[i - 1])!.type !== 'elbow') continue;
          postElbow++;
          if (isHook(combo[i])) hooks++;
        }
      }
    }
    expect(postElbow).toBeGreaterThan(100);
    expect(hooks / postElbow).toBeLessThan(0.15);
  });

  it('after knees: close work dominates (over 85%), teeps rarest (under 5%)', () => {
    let close = 0;
    let kicks = 0;
    let teeps = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const combo of combosFor({ seed, intensity: 'hard' }, 20)) {
        for (let i = 1; i < combo.length; i++) {
          if (MOVES_BY_ID.get(combo[i - 1])!.type !== 'knee') continue;
          const curr = MOVES_BY_ID.get(combo[i])!;
          if (curr.type === 'punch' || curr.type === 'elbow' || curr.type === 'knee') close++;
          else if (curr.id === 'lead-teep' || curr.id === 'rear-teep') teeps++;
          else kicks++;
        }
      }
    }
    const total = close + kicks + teeps;
    expect(total).toBeGreaterThan(100);
    expect(close / total).toBeGreaterThan(0.85);
    expect(teeps / total).toBeLessThan(0.05);
    expect(teeps).toBeLessThanOrEqual(kicks);
  });
});
