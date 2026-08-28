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

  it('only emits moves that exist in the catalog and are strikes', () => {
    for (const combo of combosFor({}, 80)) {
      expect(combo.length).toBeGreaterThan(0);
      for (const id of combo) {
        const move = MOVES_BY_ID.get(id);
        expect(move, `unknown move id ${id}`).toBeTruthy();
        expect(STRIKE_TYPES.has(move!.type), `${id} is not a strike`).toBe(true);
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
          const bothPowerSameSide = prev.power === 'power' && curr.power === 'power' && prev.side === curr.side;
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
  it('easy combos are 2-4 strikes', () => {
    for (const combo of combosFor({ intensity: 'easy' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(4);
    }
  });

  it('moderate combos are 2-5 strikes', () => {
    for (const combo of combosFor({ intensity: 'moderate' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(5);
    }
  });

  it('hard combos are 2-6 strikes', () => {
    for (const combo of combosFor({ intensity: 'hard' }, 80)) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(6);
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
