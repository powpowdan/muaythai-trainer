## Purpose

Defines how a generated workout timeline is executed as audio: beat-scheduled callouts, round bells, survival across screen lock and app backgrounding, transport controls, and coexistence with the user's own music.

## ADDED Requirements

### Requirement: Voice consistency across devices
Callouts SHALL be spoken from voice clips bundled with the app, so the voice (male) is identical on every device and does not depend on the device's installed TTS engines or voices.

#### Scenario: Same voice on any phone
- **WHEN** the app is installed on any Android device and a workout runs
- **THEN** all callouts use the bundled voice clips, regardless of the device's TTS configuration

### Requirement: Word-level beat timing
Combo callouts SHALL play one clip per move word, spaced at the engine's strike tempo for the current intensity, so each word lands on its strike beat rather than drifting at whole-phrase speech pace.

#### Scenario: Combo words land on the beat
- **WHEN** a combo callout ("one, two, kick") is dispatched during a hard-intensity workout
- **THEN** each word's clip starts within 250ms of its scheduled position (word index × strike tempo)

### Requirement: TTS fallback for missing clips
When a spoken text has no bundled clip, the app SHALL fall back to device TTS for that text without interrupting the session.

#### Scenario: Missing clip falls back
- **WHEN** a callout text is dispatched whose clip is not bundled
- **THEN** the text is spoken via device TTS and the workout continues
