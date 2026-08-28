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
