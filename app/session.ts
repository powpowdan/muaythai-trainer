import type { WorkoutTimeline } from '@muaythai/engine';

// Two-screen app: the setup screen generates the workout, the player screen
// consumes it. A module singleton avoids serializing the timeline through
// route params.
let timeline: WorkoutTimeline | null = null;

export function setCurrentTimeline(next: WorkoutTimeline): void {
  timeline = next;
}

export function takeCurrentTimeline(): WorkoutTimeline | null {
  return timeline;
}

export function clearCurrentTimeline(): void {
  timeline = null;
}
