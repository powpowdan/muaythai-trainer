## Context

Greenfield repo (`muaythai-trainer`): no code exists yet. The MVP ships an Android-first Expo app whose core value is a combo-callout engine; all platform risk is concentrated in audio (TTS timing, background playback). Reference competitor is iOS-only (OOWEE); we differentiate on Android, free, and a feel we tune ourselves. The user trains Muay Thai and is the primary test subject for pacing.

## Goals / Non-Goals

**Goals:**

- Engine as a pure-TypeScript package with zero React Native imports, unit-testable in Node with vitest
- De-risk platform unknowns first (M0 walking skeleton proves TTS + background audio before engine work)
- Deterministic, reproducible workouts (seeded) so feel-feedback ("that combo at 2:31 was awkward") maps to a fixable test case
- Adapter seams around TTS and audio so a future bundled-MP3 voice swap requires no engine or UI changes

**Non-Goals:**

- iOS builds, accounts, cloud sync, workout history/stats, subscriptions
- True audio ducking (auto-lowering the user's music during callouts) — mixing without stopping music is enough for MVP
- Clinch work, southpaw/orthodox switching as a user setting, multi-language callouts
- Integration-test scaffolding or mocked RN test environments; UI and adapters are verified on device

## Decisions

### D1: Monorepo layout — Expo app + `packages/engine`
```
muaythai-trainer/
├── app/                  # Expo app (expo-router: / = setup, /player = player)
├── packages/engine/      # pure TS: catalog, grammar, scheduler (vitest)
└── openspec/
```
The engine never imports `react-native`. This makes the TDD loop a fast `vitest --watch` in Node, and keeps the tuning surface (weights, templates, rules) free of platform noise.
*Alternative:* single Expo project with a `src/engine` folder — simpler tooling, but the package boundary is cheap insurance against RN leakage into the engine and lets tests run without any JS-mobile shims. Chose the boundary.

### D2: Combo grammar — seeded templates + constraint-checked fill
Generation is three stages:

1. **Template selection**: weighted pick from combo archetypes (`[lead-setup, power, power, finisher]`, `[jab, cross, kick]`, defense blocks, movement cues). Weights per intensity.
2. **Constrained fill**: slots filled by weighted random from enabled moves, filtered by transition rules (same-side power, kick-after-kick, lead-opening bias) using a seeded PRNG.
3. **Invariant validation**: cheap post-pass asserting the spec's naturalness rules; a fill that violates re-rolls (bounded retries, then falls back to a known-good template).

*Alternative:* free-form Markov chain over moves — produces uncanny combos and needs heavy tuning before it sounds like a gym. Templates start natural (they're lifted from how coaches call combos) and randomization keeps sessions fresh. Chose templates.

**Stance semantics:** internally moves carry `lead`/`rear` (never left/right); callouts drop the distinction for brevity ("kick", "knee", "elbow" — never "rear roundhouse"). The lead/rear metadata still drives the naturalness rules.

### D3: Pre-generated timeline, single playback clock
The scheduler expands a config into a flat, absolute-time event list (`bell`, `callout`, `cue` events) before playback starts. Playback is one monotonic elapsed-time clock; a look-ahead loop dispatches each event ~500ms before its timestamp (absorbing TTS latency).

*Why pre-generate:* determinism spec requirement, trivial pause/resume (stop the clock), trivial UI sync (binary-search the event list), and the whole workout is inspectable in tests without any audio.
*Alternative:* generate-on-the-fly per beat — less memory (irrelevant at this scale) and harder to test everywhere else.

### D4: Audio stack — expo-speech + expo-audio with adapter seams
- `expo-speech` for callouts (utterance queue, rate/pitch tuning, `onDone` for pacing calibration)
- `expo-audio` for bells; config plugin `enableBackgroundPlayback: true` adds the Android media foreground service + permissions; `setActiveForLockScreen` exposes notification/lock-screen controls; `interruptionMode: 'mixWithOthers'` so the user's music keeps playing
- Interfaces `Speaker` and `Sfx` in the app wrap these, so bundling recorded MP3 callouts later is an adapter swap, not a redesign
- **TTS warm-up:** on app start, speak a zero-volume utterance once; first real callout then meets the 250ms budget

**Known wrinkle to verify in M0:** whether the foreground service stays alive when only TTS is speaking (no active audio player). Mitigation if not: keep a silent looping AudioPlayer active for the session's duration.

### D5: App state — no state library
A `PlaybackController` class owns the clock and event dispatch, publishing state (phase, remaining, current combo) through React state in the player screen. Workout config persists as one JSON blob in AsyncStorage. No Redux/Zustand for a two-screen app.

### D6: Testing strategy (test-first on the critical path)
- Vitest on `packages/engine`: every spec invariant in `workout-generation` is a test written before the code that satisfies it (config respect, naturalness rules, length/density scaling, timeline exactness, seed determinism). Naturalness tests are property-style: generate N workouts across intensities, assert invariants hold on all.
- Catalog integrity is a single schema test over the data file.
- No tests for screens/adapters beyond what M0 exercises on a real device.
- Feel-sprint workflow: every "that felt wrong" from dogfooding becomes a failing invariant test first, then a fix — the tuning loop accumulates as regression protection.

## Risks / Trade-offs

- [TTS voice quality varies by device/engine (Google vs Samsung)] → tune rate/pitch; the `Speaker` adapter's bundled-MP3 escape hatch exists precisely for this; decide after first on-device session
- [Foreground service may die without an active player, or be killed by OEM battery optimizers] → M0 verifies on the user's actual phone on day one; silent-loop keepalive if needed; prompt for battery-optimization exemption if the user's device requires it
- [TTS utterances queue in order but can drift under load] → look-ahead dispatch plus a clock resync check each event; worst case the display text stays correct even if a callout lands late
- [Template-based grammar can feel repetitive before weights are tuned] → accepted deliberately; that's what the M3 feel sprint is for, and seeded reproducibility makes each tuning pass measurable
- [Dev on WSL (`/mnt/c`) makes Expo dev-server file watching slow] → develop engine via vitest in pure Node; run the app against a dev-client build or `--tunnel`; tolerate the watch latency since UI iteration is a small fraction of the work

## Open Questions

- Final move list and exact set of templates/weights (settled during M1/M3 tuning; spec invariants don't depend on the specific list)
- Bell audio assets (any free boxing bell sample; swap-able file)
- Whether rest periods announce "round X" with voice or bell only (taste call, decided in M2)
- Number of intensity levels (3 planned: easy/moderate/hard)
