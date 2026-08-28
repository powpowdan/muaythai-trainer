## 1. M0: Walking skeleton (de-risk platform first)

- [x] 1.1 Scaffold Expo app (TypeScript, expo-router, two routes: `/` setup stub, `/player`) and `packages/engine` package with vitest; monorepo wiring so `app` imports `engine`
- [x] 1.2 Minimal player: start button runs a hardcoded 1-round timeline (10s work) that speaks "Round 1" via expo-speech and plays a bell via expo-audio
- [ ] 1.3 Enable background playback (expo-audio config plugin), lock-screen controls, `mixWithOthers`; verify on a real Android device: screen off → callouts continue; music app keeps playing under callouts; notification shows controls
- [ ] 1.4 Verify TTS timing on device (warm-up approach, first-callout latency); if foreground service dies between bells, add silent-loop keepalive player

## 2. Move catalog (data + integrity)

- [x] 2.1 Define engine types: `Move` (id, side, type, power, calloutText, displayText), `WorkoutConfig`, `TimelineEvent`; write the catalog integrity test (all fields populated, unique ids, numbers-as-words) and make it fail
- [x] 2.2 Author the Muay Thai move catalog (punches 1–6, kicks, teeps, knees, elbows, defenses, movement cues) with lead/rear sides and TTS/display texts; integrity test passes

## 3. Combo grammar (test-first)

- [x] 3.1 Write failing property tests for config respect and naturalness invariants: disabled moves never called, no same-side power chains (except double jab/teep), no same-side kick-after-kick, ≥70% lead/neutral openings across N generated combos
- [x] 3.2 Write failing tests for intensity scaling: combo length bounds (2–4 easy, 2–6 hard) and monotonic callout density per intensity level
- [x] 3.3 Implement seeded PRNG, weighted combo template selection, constrained slot fill, and invariant-validation re-roll loop; all grammar tests pass

## 4. Workout scheduler (test-first)

- [x] 4.1 Write failing scheduler tests: timeline fills rounds exactly, no callout crosses the round-end bell, rest periods contain no strike callouts, bells at boundaries, identical config+seed → identical timeline
- [x] 4.2 Implement timeline expander (config → flat absolute-time event list with callouts paced by intensity, defense/movement cues interleaved, bells, rest announcements); scheduler tests pass

## 5. Playback layer

- [x] 5.1 Implement `PlaybackController`: monotonic elapsed clock, 500ms look-ahead event dispatch to `Speaker`/`Sfx` adapters, phase/remaining/current-combo state published to React
- [x] 5.2 Implement transport: pause (halt clock, flush queued speech), resume from exact position, skip to next round boundary, end (stop audio, clear lock-screen controls); wire notification/lock-screen buttons
- [ ] 5.3 On-device check: callout timing within 250ms of schedule across a full round, pause/resume produces no duplicated or skipped callouts

## 6. Setup screen

- [x] 6.1 Config state model + AsyncStorage persistence (restore on launch)
- [x] 6.2 Setup UI: rounds/round-duration/rest pickers with bounded ranges, intensity selector, per-move and per-move-group toggles, start guard (≥1 strike enabled), start → generate seeded workout → navigate to player

## 7. Player screen

- [x] 7.1 Player UI: round number, work/rest phase, per-second countdown, current combo text with 2-combo history, pause/skip/end controls
- [x] 7.2 End-of-workout flow: final bell, stop audio, clear controls, return to setup

## 8. M4: Build, install, feel sprint

- [ ] 8.1 EAS build (or local gradle) production APK; sideload on personal phone; confirm background playback on the actual daily device
- [ ] 8.2 Feel sprint: daily training sessions; each "felt wrong" report becomes a failing grammar/scheduler test, then a weight/template/rule fix; repeat until sessions flow (ongoing, not blocking archive if MVP specs all hold)
