export type MoveSide = 'lead' | 'rear' | 'neutral';
export type MoveType = 'punch' | 'kick' | 'knee' | 'elbow' | 'defense' | 'movement';
export type MovePower = 'light' | 'power';
export type Intensity = 'easy' | 'moderate' | 'hard';

export interface Move {
  /** Unique identifier, e.g. 'jab', 'kick-rear' */
  id: string;
  /** Stance side driving the move (never left/right — stance-agnostic). */
  side: MoveSide;
  type: MoveType;
  power: MovePower;
  /** Text fed to TTS. Numbers spelled as words: 'one', not '1'. */
  calloutText: string;
  /** Compact on-screen text: '1', 'kick', 'slip'. */
  displayText: string;
}

export interface WorkoutConfig {
  /** 1–12 */
  rounds: number;
  /** Round duration in seconds, 60–300 */
  roundSeconds: number;
  /** Rest duration in seconds, 15–120 */
  restSeconds: number;
  intensity: Intensity;
  /** Move ids excluded from generation. */
  disabledMoveIds: string[];
  /** PRNG seed — same config + seed ⇒ identical timeline. */
  seed: number;
}

export type BellKind = 'round-start' | 'round-end' | 'final';

export type TimelineEvent =
  | { kind: 'bell'; at: number; bell: BellKind }
  | { kind: 'announcement'; at: number; calloutText: string; displayText: string }
  | { kind: 'callout'; at: number; moveIds: string[]; durationSeconds: number }
  | { kind: 'cue'; at: number; moveId: string };

export interface Phase {
  kind: 'work' | 'rest';
  /** Inclusive start, seconds from workout start. */
  start: number;
  /** Exclusive end, seconds from workout start. */
  end: number;
  /** 1-based round number this phase belongs to. */
  round: number;
}

export interface WorkoutTimeline {
  config: WorkoutConfig;
  /** Absolute-time events, sorted by `at`. */
  events: TimelineEvent[];
  phases: Phase[];
  totalSeconds: number;
}
