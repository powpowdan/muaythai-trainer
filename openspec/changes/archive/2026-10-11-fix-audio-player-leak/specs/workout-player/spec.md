## ADDED Requirements

### Requirement: Timer runs independently of audio health
The timeline timer SHALL start and keep running regardless of audio subsystem state. An audio initialization failure or a failed audio playback start SHALL NOT prevent the timer from starting, SHALL NOT pause or stall the timer mid-session, and SHALL NOT be interpreted as a user-initiated pause. Lock-screen pause detection SHALL only report a pause when playback was previously playing and was paused externally.

#### Scenario: Session starts when audio init fails
- **WHEN** a workout is started while the audio subsystem cannot initialize playback
- **THEN** the timer starts and counts down normally, callout text updates on schedule, and the failure is surfaced as a visible error rather than a frozen screen

#### Scenario: Failed keepalive start is not a user pause
- **WHEN** the background-playback keepalive audio fails to start at session start or after a resume
- **THEN** the workout timer and callout dispatch continue running, and the app degrades to playing without lock-screen controls

#### Scenario: Timer recovers after a degraded prior session
- **WHEN** a previous session in the same app process ended with audio in a failed state and the user starts a new workout
- **THEN** the new session's timer starts and runs without requiring an app restart

### Requirement: Playback start errors are surfaced
Failures while starting playback (audio mode configuration, session activation) SHALL be reported to the user interface rather than silently leaving the player screen in an indeterminate state.

#### Scenario: Start failure shows feedback
- **WHEN** playback setup fails before the timer would start
- **THEN** the player screen shows an actionable error state and offers the user a way back or retry, instead of showing stale or empty content
