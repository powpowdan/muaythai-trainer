## Why

Shadowboxing and bag work go stale fast: pre-planned routines are repetitive, and YouTube follow-along videos kill the music and don't adapt. An audio callout app that speaks randomized, natural-feeling Muay Thai combinations keeps solo training fresh. The closest competitor (OOWEE) is iOS-only and subscription-based; we are building for Android, for ourselves, free of any monetization pressure.

## What Changes

- New Expo (React Native, TypeScript) Android app — first code in this repo
- A pure-TypeScript workout engine: Muay Thai move catalog, combo grammar that generates natural combinations, and a scheduler that paces callouts across rounds/rest into a precise timeline
- Callout playback: TTS voice on the beat ("one, two, kick" style — punches by number, kicks/knees/elbows/defense by name), round bells, continued playback with screen off via background audio + lock screen controls
- Workout setup screen: discipline fixed to Muay Thai; rounds, round length, rest length, intensity, and per-move enable/disable; settings persist
- Workout player screen: round/rest countdown, current and recent combos as visual text (backup for missed callouts), pause/skip/end controls
- Test-first development on the engine: grammar naturalness and scheduler timeline invariants expressed as unit tests (vitest); UI and audio adapters verified on device, not with integration test scaffolding

## Capabilities

### New Capabilities

- `workout-generation`: Move catalog, combo grammar, and workout scheduler. Takes a workout config and produces a full timeline of callout events (combos, defense/movement cues, bells, rest boundaries) with natural sequencing that respects the user's move selection and intensity.
- `callout-playback`: Executes a workout timeline as audio. Beat-scheduled TTS callouts, bell sounds, playback that survives screen lock via a media foreground service with notification/lock-screen controls, pause/resume/skip without losing timeline position, and mixing over other apps' audio without stopping it.
- `workout-setup`: Screen where the user configures rounds, round duration, rest duration, intensity, and enabled moves. Configuration persists between launches.
- `workout-player`: Screen displaying workout state in real time: round number and phase, countdown timer, current and recent callout text, and controls to pause, skip, or end the workout.

### Modified Capabilities

(none — no existing specs)

## Impact

- Entire repo is new: Expo app skeleton, `packages/engine` (pure TS, vitest), app screens
- New dependencies: expo, expo-speech, expo-audio (with `enableBackgroundPlayback` config plugin), react-navigation (or expo-router), AsyncStorage (or equivalent) for config persistence
- No backend, no accounts, no network calls at runtime; works fully offline
- Builds target Android first (EAS build / sideloaded APK); iOS is out of scope but nothing in the stack forecloses it
