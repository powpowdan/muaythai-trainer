import { describe, expect, it } from 'vitest';
import { generateWorkout, strikeUnits } from '../src/scheduler';
import type { WorkoutConfig, WorkoutTimeline } from '../src/types';

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

function workPhases(timeline: WorkoutTimeline) {
  return timeline.phases.filter((p) => p.kind === 'work');
}

function restPhases(timeline: WorkoutTimeline) {
  return timeline.phases.filter((p) => p.kind === 'rest');
}

function containingPhase(timeline: WorkoutTimeline, at: number) {
  return timeline.phases.find((p) => at >= p.start && at < p.end);
}

describe('scheduler: structure', () => {
  it('phases tile the workout exactly: work/rest alternating, no gaps', () => {
    const timeline = generateWorkout(config());
    expect(timeline.phases.length).toBe(5); // 3 work + 2 rest
    expect(timeline.phases[0]).toMatchObject({ kind: 'work', round: 1, start: 0 });
    expect(timeline.phases[1]).toMatchObject({ kind: 'rest', round: 1 });
    expect(timeline.phases[2]).toMatchObject({ kind: 'work', round: 2 });
    expect(timeline.phases[3]).toMatchObject({ kind: 'rest', round: 2 });
    expect(timeline.phases[4]).toMatchObject({ kind: 'work', round: 3 });
    for (let i = 1; i < timeline.phases.length; i++) {
      expect(timeline.phases[i].start).toBe(timeline.phases[i - 1].end);
    }
    const expectedTotal = 3 * 180 + 2 * 60;
    expect(timeline.totalSeconds).toBe(expectedTotal);
    expect(timeline.phases[timeline.phases.length - 1].end).toBe(expectedTotal);
  });

  it('events are sorted by time', () => {
    const timeline = generateWorkout(config());
    const ats = timeline.events.map((e) => e.at);
    const sorted = [...ats].sort((a, b) => a - b);
    expect(ats).toEqual(sorted);
    expect(ats[ats.length - 1]).toBeLessThanOrEqual(timeline.totalSeconds);
  });
});

describe('scheduler: bells at boundaries', () => {
  it('every work phase opens with a round-start bell and closes with round-end (or final)', () => {
    const timeline = generateWorkout(config());
    const works = workPhases(timeline);
    for (let i = 0; i < works.length; i++) {
      const p = works[i];
      const startBell = timeline.events.find(
        (e) => e.kind === 'bell' && e.at === p.start,
      );
      expect(startBell, `round ${p.round} missing start bell`).toBeTruthy();
      const endBell = timeline.events.find((e) => e.kind === 'bell' && e.at === p.end);
      expect(endBell, `round ${p.round} missing end bell`).toBeTruthy();
      const isLast = i === works.length - 1;
      expect((endBell as { bell: string }).bell).toBe(isLast ? 'final' : 'round-end');
    }
  });
});

describe('scheduler: timeline exactness', () => {
  it('no callout or cue crosses its round-end bell', () => {
    const timeline = generateWorkout(config({ rounds: 4, roundSeconds: 120, restSeconds: 30 }));
    for (const ev of timeline.events) {
      if (ev.kind !== 'callout' && ev.kind !== 'cue') continue;
      const phase = containingPhase(timeline, ev.at);
      expect(phase, `event at ${ev.at} outside all phases`).toBeTruthy();
      const duration = ev.kind === 'callout' ? ev.durationSeconds : 1.5;
      expect(
        ev.at + duration,
        `event at ${ev.at} (+${duration}s) crosses ${phase!.kind} boundary ${phase!.end}`,
      ).toBeLessThanOrEqual(phase!.end);
    }
  });

  it('rest periods contain no callouts or cues', () => {
    const timeline = generateWorkout(config());
    for (const rest of restPhases(timeline)) {
      const violators = timeline.events.filter((ev) => {
        const inRest = ev.at >= rest.start && ev.at < rest.end;
        return inRest && (ev.kind === 'callout' || ev.kind === 'cue');
      });
      expect(violators, `rest after round ${rest.round} has strike events`).toEqual([]);
    }
  });

  it('work rounds actually contain callouts', () => {
    const timeline = generateWorkout(config());
    for (const work of workPhases(timeline)) {
      const callouts = timeline.events.filter(
        (ev) => ev.kind === 'callout' && ev.at >= work.start && ev.at < work.end,
      );
      expect(callouts.length, `round ${work.round} has no callouts`).toBeGreaterThan(0);
    }
  });
});

describe('scheduler: density monotonic with intensity', () => {
  it('first-round callout counts are non-decreasing easy → hard', () => {
    const counts = (['easy', 'moderate', 'hard'] as const).map((intensity) => {
      const timeline = generateWorkout(config({ intensity, rounds: 1, roundSeconds: 180 }));
      return timeline.events.filter((e) => e.kind === 'callout').length;
    });
    expect(counts[0]).toBeLessThanOrEqual(counts[1]);
    expect(counts[1]).toBeLessThanOrEqual(counts[2]);
    expect(counts[2]).toBeGreaterThan(0);
  });
});

describe('scheduler: pacing of multi-strike units', () => {
  it('a combo containing double-jab is paced longer than the same combo with a plain jab', () => {
    const strikeSeconds = 0.75;
    const withUnit = strikeUnits(['double-jab', 'cross', 'lead-hook']) * strikeSeconds + 0.4;
    const withJab = strikeUnits(['jab', 'cross', 'lead-hook']) * strikeSeconds + 0.4;
    expect(withUnit).toBeCloseTo(1.5 * 0.75 + 2 * 0.75 + 0.4, 5);
    expect(withJab).toBeCloseTo(3 * 0.75 + 0.4, 5);
    expect(withUnit - withJab).toBeCloseTo(0.5 * strikeSeconds, 5);
  });

  it('every catalog move contributes at least one strike unit', () => {
    for (const id of ['jab', 'cross', 'lead-hook', 'rear-kick', 'lead-knee', 'lead-elbow', 'lead-teep']) {
      expect(strikeUnits([id])).toBeGreaterThanOrEqual(1);
    }
    expect(strikeUnits(['double-jab'])).toBe(1.5);
  });
});

describe('scheduler: determinism', () => {
  it('same config and seed produce identical timelines', () => {
    const cfg = config({ seed: 987 });
    expect(generateWorkout(cfg)).toEqual(generateWorkout(cfg));
  });

  it('different seeds produce different timelines', () => {
    const a = generateWorkout(config({ seed: 1 }));
    const b = generateWorkout(config({ seed: 2 }));
    expect(a.events).not.toEqual(b.events);
  });
});
