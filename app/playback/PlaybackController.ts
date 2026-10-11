import { MOVES_BY_ID, type TimelineEvent, type WorkoutTimeline } from '@muaythai/engine';

export interface PlaybackDeps {
  speaker: { speak(text: string): void; stop(): void; dispose(): void };
  sfx: {
    playBell(kind: 'round-start' | 'round-end' | 'final'): void;
    startSession(): void | Promise<void>;
    isExternallyPaused(): boolean;
    setPaused(paused: boolean): void;
    setMetadata(title: string): void;
    endSession(): void;
  };
  configureAudio(): Promise<void>;
}

export interface PlaybackState {
  phase: 'work' | 'rest' | 'done';
  round: number;
  totalRounds: number;
  remainingSeconds: number;
  currentComboText: string | null;
  recentCombos: string[];
  isPaused: boolean;
  /** Audio setup failed — the timer runs on without sound/lock-screen controls. */
  startError: boolean;
}

const TICK_MS = 100;
const LOOKAHEAD_SECONDS = 0.5;

export class PlaybackController {
  private readonly timeline: WorkoutTimeline;
  private readonly deps: PlaybackDeps;
  private readonly onState: (state: PlaybackState) => void;
  private readonly onEnd: (completed: boolean) => void;

  private interval: ReturnType<typeof setInterval> | null = null;
  private baseElapsed = 0;
  private resumedAtWall = 0;
  private dispatched = 0;
  private selfPaused = false;
  private ended = false;
  private startError = false;
  private lastState = '';

  constructor(
    timeline: WorkoutTimeline,
    deps: PlaybackDeps,
    onState: (state: PlaybackState) => void,
    onEnd: (completed: boolean) => void,
  ) {
    this.timeline = timeline;
    this.deps = deps;
    this.onState = onState;
    this.onEnd = onEnd;
  }

  async start(): Promise<void> {
    // Audio setup failure must never block the timeline: the timer keeps
    // running silent and the UI surfaces the error via state.startError.
    try {
      await this.deps.configureAudio();
      await this.deps.sfx.startSession();
    } catch (err) {
      console.warn('[PlaybackController] audio setup failed; continuing silent', err);
      this.startError = true;
    }
    // Unmount raced the async setup: end() already tore the session down —
    // bail or we'd resurrect an orphaned interval speaking into disposed audio.
    if (this.ended) return;
    this.publish(true);
    this.resumedAtWall = Date.now();
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  pause(): void {
    if (!this.interval || this.selfPaused) return;
    this.baseElapsed = this.elapsed();
    this.selfPaused = true;
    this.deps.speaker.stop();
    this.deps.sfx.setPaused(true);
    clearInterval(this.interval);
    this.interval = null;
    this.publish(true);
  }

  resume(): void {
    if (this.interval || !this.selfPaused) return;
    this.selfPaused = false;
    this.deps.sfx.setPaused(false);
    this.resumedAtWall = Date.now();
    this.interval = setInterval(() => this.tick(), TICK_MS);
    this.publish(true);
  }

  /** Work → start of next rest (or end). Rest → start of next round. */
  skip(): void {
    const now = this.elapsed();
    const phase = this.phaseAt(now);
    if (!phase || phase.kind === 'done') return;
    const target = phase.end;
    this.deps.speaker.stop();
    this.baseElapsed = target;
    this.resumedAtWall = Date.now();
    // Jump the dispatch pointer past everything before the boundary; events
    // exactly at the boundary (bell, announcement) still fire.
    while (this.dispatched < this.timeline.events.length && this.timeline.events[this.dispatched].at < target) {
      this.dispatched++;
    }
    this.publish(true);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.deps.speaker.dispose();
    this.deps.sfx.endSession();
    this.onEnd(true);
  }

  private elapsed(): number {
    if (this.selfPaused || !this.interval) return this.baseElapsed;
    return this.baseElapsed + (Date.now() - this.resumedAtWall) / 1000;
  }

  private tick(): void {
    // Lock screen / notification pause: keepalive player was paused externally.
    if (!this.selfPaused && this.deps.sfx.isExternallyPaused()) {
      this.pause();
      return;
    }
    const now = this.elapsed();

    const events = this.timeline.events;
    while (this.dispatched < events.length && events[this.dispatched].at <= now + LOOKAHEAD_SECONDS) {
      this.dispatchEvent(events[this.dispatched]);
      this.dispatched++;
    }

    if (now >= this.timeline.totalSeconds) {
      this.baseElapsed = this.timeline.totalSeconds;
      this.end();
      return;
    }
    this.publish(false);
  }

  private dispatchedText: string | null = null;
  private recent: string[] = [];

  private dispatchEvent(ev: TimelineEvent): void {
    switch (ev.kind) {
      case 'bell':
        this.deps.sfx.playBell(ev.bell);
        break;
      case 'announcement':
        this.deps.speaker.speak(ev.calloutText);
        break;
      case 'callout': {
        const text = ev.moveIds
          .map((id) => moveDisplay(id))
          .join('-');
        this.deps.speaker.speak(
          ev.moveIds.map((id) => moveCallout(id)).join(', '),
        );
        this.pushCombo(text);
        break;
      }
      case 'cue': {
        this.deps.speaker.speak(moveCallout(ev.moveId));
        this.pushCombo(moveDisplay(ev.moveId));
        break;
      }
    }
  }

  private pushCombo(text: string): void {
    this.dispatchedText = text;
    this.recent = [text, ...this.recent].slice(0, 3);
  }

  private phaseAt(now: number) {
    if (now >= this.timeline.totalSeconds) {
      return { kind: 'done' as const, start: now, end: now, round: this.timeline.config.rounds };
    }
    return this.timeline.phases.find((p) => now >= p.start && now < p.end) ?? null;
  }

  private publish(force: boolean): void {
    const now = this.elapsed();
    const phase = this.phaseAt(now);
    const state: PlaybackState = {
      phase: phase?.kind ?? 'done',
      round: phase?.round ?? this.timeline.config.rounds,
      totalRounds: this.timeline.config.rounds,
      remainingSeconds: Math.max(0, Math.ceil((phase ? phase.end - now : 0))),
      currentComboText: this.dispatchedText,
      recentCombos: this.recent.slice(1),
      isPaused: this.selfPaused,
      startError: this.startError,
    };
    const key = JSON.stringify(state);
    if (force || key !== this.lastState) {
      this.lastState = key;
      this.onState(state);
    }
  }
}

const DISPLAY_BY_ID = new Map(
  [...MOVES_BY_ID.values()].map((m) => [m.id, m] as const),
);

function moveDisplay(id: string): string {
  return DISPLAY_BY_ID.get(id)?.displayText ?? id;
}

function moveCallout(id: string): string {
  return DISPLAY_BY_ID.get(id)?.calloutText ?? id;
}
