## Purpose

Defines how a generated workout timeline is executed as audio: beat-scheduled TTS callouts, round bells, survival across screen lock and app backgrounding, transport controls, and coexistence with the user's own music.


### Requirement: Beat-accurate callouts
Each spoken callout SHALL begin within 250ms of its scheduled start time in the timeline.

#### Scenario: Callout starts on schedule
- **WHEN** the timeline schedules a callout at time T during playback
- **THEN** the spoken audio is audible by T + 250ms

### Requirement: First callout is not delayed
The speech engine SHALL be initialized and warmed up before playback begins so the first callout of a session meets the same timing requirement as all others.

#### Scenario: Cold start timing
- **WHEN** a workout is started from a fresh app launch
- **THEN** the first callout occurs within 250ms of its scheduled time

### Requirement: Round bells
A bell sound SHALL play at the start of every working round, the end of every working round, and the end of the final round.

#### Scenario: Round boundaries have bells
- **WHEN** a workout plays through a round transition
- **THEN** a distinct bell marks the transition, with the final bell differing from round bells

### Requirement: Playback survives backgrounding
Audio playback SHALL continue indefinitely while the screen is off or the app is backgrounded, with a system notification exposing play/pause and stop controls. Playback SHALL NOT be interrupted by brief focus loss such as a notification chime.

#### Scenario: Screen off during bag work
- **WHEN** the screen locks mid-workout
- **THEN** callouts and bells continue on schedule until the workout ends or the user stops it

#### Scenario: Lock screen controls
- **WHEN** playback is active and the device is locked
- **THEN** the user can pause or stop playback from the lock screen or notification without unlocking

### Requirement: Transport controls preserve timeline position
Pausing SHALL halt the timeline clock without discarding position; resuming SHALL continue from the paused position; skipping SHALL advance to the next round boundary; ending SHALL stop all audio and release audio resources.

#### Scenario: Pause and resume
- **WHEN** the user pauses mid-round and resumes
- **THEN** callouts continue from the exact timeline position where paused, with no skipped or duplicated callouts beyond the pause point

#### Scenario: Skip jumps to next round
- **WHEN** the user skips during a working round
- **THEN** playback jumps to the start of the next rest period, or ends the workout if it was the final round

### Requirement: Coexist with user's music
Callouts and bells SHALL mix with audio from other apps (e.g. a music player) rather than pausing or stopping it.

#### Scenario: Music keeps playing
- **WHEN** the user is playing music in another app and starts a workout
- **THEN** the music continues playing underneath the callouts for the entire session


### Requirement: Voice consistency across devices
Callouts SHALL be spoken from voice clips bundled with the app, so the voice (male) is identical on every device and does not depend on the device's installed TTS engines or voices.

#### Scenario: Same voice on any phone
- **WHEN** the app is installed on any Android device and a workout runs
- **THEN** all callouts use the bundled voice clips, regardless of the device's TTS configuration

### Requirement: Word-level beat timing
Combo callouts SHALL play one clip per move word, spaced at the engine's strike tempo for the current intensity, so each word lands on its strike beat rather than drifting at whole-phrase speech pace. Words that voice multiple strikes (e.g. "double jab") SHALL be allotted proportionally more time: each subsequent word's start offset SHALL account for the duration of the words before it, not merely its index.

#### Scenario: Combo words land on the beat
- **WHEN** a combo callout ("one, two, kick") is dispatched during a hard-intensity workout
- **THEN** each word's clip starts within 250ms of its scheduled position (cumulative per-word durations at the current strike tempo)

#### Scenario: Doubled words get room
- **WHEN** a combo callout containing "double jab" is dispatched at any intensity
- **THEN** the word after "double jab" starts later than a single-strike word would have, proportional to the doubled strike duration

### Requirement: TTS fallback for missing clips
When a spoken text has no bundled clip, the app SHALL fall back to device TTS for that text without interrupting the session.

#### Scenario: Missing clip falls back
- **WHEN** a callout text is dispatched whose clip is not bundled
- **THEN** the text is spoken via device TTS and the workout continues

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
