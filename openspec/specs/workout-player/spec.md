## Purpose

Defines the workout player screen: real-time visual state during playback so the user can follow the session at a glance when audio alone isn't enough.


### Requirement: Display session state
During playback the screen SHALL show the current round number, the current phase (work or rest), and a countdown timer for the current phase, updating at least once per second.

#### Scenario: Round timer counts down
- **WHEN** a working round is in progress
- **THEN** the displayed remaining time decreases each second and matches the configured round duration at round start

### Requirement: Display callout text
During working rounds the screen SHALL show the current combination as readable text (e.g. "1-2-kick") plus at least the two most recent combinations, so a missed callout can be recovered visually.

#### Scenario: Combo text syncs with audio
- **WHEN** a callout is spoken
- **THEN** its text appears as the current combination and remains visible in the recent list after the next callout replaces it

### Requirement: Transport controls on screen
The player SHALL offer pause/resume, skip, and end-workout controls at all times during playback, wired to the playback layer's transport behavior.

#### Scenario: Ending a workout
- **WHEN** the user taps end workout
- **THEN** audio stops, lock-screen/notification controls are cleared, and the user is returned to the setup screen

#### Scenario: Pausing from the player
- **WHEN** the user taps pause during a round
- **THEN** the timer and callouts halt and the control becomes resume

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
