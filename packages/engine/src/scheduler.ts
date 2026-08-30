import { generateCombo, INTENSITY_PARAMS, pickCue, createRng, type Rng } from './grammar';
import { MOVES_BY_ID } from './catalog';
import type {
  Phase,
  TimelineEvent,
  WorkoutConfig,
  WorkoutTimeline,
} from './types';

const INITIAL_GRACE_SECONDS = 2.5; // breathing room after the round bell
const BELL_SAFETY_MARGIN = 1.0; // last callout must end this far before the bell
const CUE_DURATION_SECONDS = 1.5;
const CUE_CHANCE = 0.3; // chance a rest-gap between combos carries a defense/movement cue

function announcement(text: string, at: number): TimelineEvent {
  return { kind: 'announcement', at, calloutText: text, displayText: text };
}

function scheduleWorkRound(
  round: number,
  start: number,
  end: number,
  config: WorkoutConfig,
  rng: Rng,
  events: TimelineEvent[],
): void {
  const params = INTENSITY_PARAMS[config.intensity];
  const disabled = new Set(config.disabledMoveIds);
  const strikes = [...MOVES_BY_ID.values()].filter(
    (m) =>
      (m.type === 'punch' || m.type === 'kick' || m.type === 'knee' || m.type === 'elbow') &&
      !disabled.has(m.id),
  );

  events.push(announcement(`round ${numberWord(round)}`, start));

  let t = start + INITIAL_GRACE_SECONDS;
  while (t < end - BELL_SAFETY_MARGIN) {
    const moveIds = generateCombo(rng, params, strikes, { backEnabled: !disabled.has('step-back') });
    if (moveIds.length < 2) break; // not enough enabled strikes to build combos
    const duration = moveIds.length * params.strikeSeconds + 0.4;
    if (t + duration > end - BELL_SAFETY_MARGIN) break;
    events.push({ kind: 'callout', at: t, moveIds, durationSeconds: duration });
    const gap = params.gapSeconds * (0.75 + 0.5 * rng());
    // Occasionally drop a defense/movement cue into the breath between combos.
    if (rng() < CUE_CHANCE && t + duration + CUE_DURATION_SECONDS <= end - BELL_SAFETY_MARGIN) {
      const cueId = pickCue(rng, config);
      if (cueId) events.push({ kind: 'cue', at: t + duration + gap * 0.35, moveId: cueId });
    }
    t += duration + gap;
  }
}

function numberWord(n: number): string {
  const words = [
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve',
  ];
  return words[n - 1] ?? String(n);
}

export function generateWorkout(config: WorkoutConfig): WorkoutTimeline {
  const rng = createRng(config.seed);
  const events: TimelineEvent[] = [];
  const phases: Phase[] = [];
  let t = 0;

  for (let round = 1; round <= config.rounds; round++) {
    const workEnd = t + config.roundSeconds;
    phases.push({ kind: 'work', start: t, end: workEnd, round });
    events.push({ kind: 'bell', at: t, bell: 'round-start' });
    scheduleWorkRound(round, t, workEnd, config, rng, events);
    const isFinal = round === config.rounds;
    events.push({ kind: 'bell', at: workEnd, bell: isFinal ? 'final' : 'round-end' });
    t = workEnd;

    if (!isFinal) {
      const restEnd = t + config.restSeconds;
      phases.push({ kind: 'rest', start: t, end: restEnd, round });
      events.push(announcement('rest', t));
      t = restEnd;
    }
  }

  const priority: Record<TimelineEvent['kind'], number> = {
    bell: 0,
    announcement: 1,
    callout: 2,
    cue: 3,
  };
  events.sort((a, b) => a.at - b.at || priority[a.kind] - priority[b.kind]);

  return { config, events, phases, totalSeconds: t };
}
