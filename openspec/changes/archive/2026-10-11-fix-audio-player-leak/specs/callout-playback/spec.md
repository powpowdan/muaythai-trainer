## ADDED Requirements

### Requirement: Sustained callout audio across full sessions
Callouts and bells SHALL remain audible for the entire duration of any supported workout (up to 12 rounds × 300s) without degradation, and audio failures mid-session SHALL be transient errors, never a permanent loss of voice while the session continues dispatching callouts.

#### Scenario: Voice survives past ninety seconds
- **WHEN** a moderate-intensity workout with default timing plays on device past the 90-second mark
- **THEN** every dispatched callout is audible, and no callout is silently dropped after any earlier callout

#### Scenario: Back-to-back sessions keep voice
- **WHEN** a workout is ended mid-round and a new workout is started immediately in the same app process
- **THEN** all callouts in the second session are audible

### Requirement: Bounded native audio resource usage
The number of native audio player instances allocated by a session SHALL be bounded by the size of the bundled clip vocabulary (plus bells and keepalive), independent of workout length, round count, or callout density. Playing a callout SHALL NOT allocate a new native audio player per spoken word.

#### Scenario: Track count stays flat through a long session
- **WHEN** a hard-intensity, multi-round workout plays from start to end
- **THEN** the app's live native audio track count plateaus at the pooled-player total and never grows with the number of spoken callouts
