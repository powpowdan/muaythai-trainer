## Context

The MVP ships `expo-speech` TTS callouts behind a `Speaker` adapter seam (archived change `add-mvp-callout-trainer`, design D4). The voice must be male on every device; device TTS cannot guarantee gender or quality. Main specs for `callout-playback` already require beat-accurate callouts and warm-up.

## Goals / Non-Goals

**Goals:**

- Identical male voice on every device via bundled MP3 clips
- One source of truth for the clip list shared by the generator script and the app
- Word-level clip scheduling at engine strike tempo (better pacing than whole-phrase TTS)
- Zero-behavior-change fallback to TTS for any text without a clip

**Non-Goals:**

- Multiple selectable voices / voice settings UI (one voice, chosen at generation time)
- Cloud TTS at runtime (clips are generated once at build time; the app is fully offline)
- Changing the engine's grammar, scheduler, or timing estimates (already correct: `n × strikeSeconds + tail` now matches real playback)

## Decisions

### D1: Generation via `msedge-tts` (npm), voice `en-US-GuyNeural`
Free, no API key, pure Node — runs under our Windows-side npm setup. `en-US-ChristopherNeural` is the alternate if Guy's read doesn't feel right; regenerating is one command with identical filenames (clip set is deterministic), so swapping voices later costs nothing. *Alternative:* ElevenLabs (better quality, paid, API key) — kept as a future drop-in for the same script.

### D2: Engine owns the clip vocabulary (`src/voice.ts`)
The engine derives the clip list from `CATALOG` callout texts (distinct words, not per-move — `kick-lead`/`kick-rear` share "kick") plus fixed announcements ("round one"…"round twelve" as single clips for natural prosody, "rest", "time"). It exports a text→filename mapping (`slug`) the app and generator both consume. *Why in the engine:* the vocabulary is defined by what the scheduler can emit — keeping it next to the catalog makes it impossible for the generator and app to drift from the engine.

### D3: Generated manifest, static requires
Metro cannot bundle dynamic `require()`s, so `gen-voice.mjs` writes `app/audio/voice-manifest.ts` mapping every clip name to a static `require('../assets/voice/<name>.mp3')`. The manifest is committed; regenerating clips refreshes audio files without touching app code.

### D4: `Mp3Speaker` implementation
- Announcements (`round three`, `rest`, `time`) → single clip lookup
- Combos (`one, two, kick`) → split on comma, schedule word i at `i × strikeSeconds` via `setTimeout`, each word played from a preloaded source
- Sources preloaded once at warm-up (`Audio.preload`); playback via short-lived `AudioPlayer` per utterance, released on completion
- `stop()` cancels pending timeouts and current players (pause/end semantics unchanged)
- Missing clip → the whole text goes to `expo-speech` (fallback is per-utterance, not per-word, to avoid mixing voices inside one combo)
- Pacing (`strikeSeconds`) injected at construction from the workout's intensity; the `Speaker` interface stays `speak/stop/warmUp`

## Risks / Trade-offs

- [msedge-tts is an unofficial client for Edge's read-aloud service] → clips are committed; if the service dies later, existing clips keep working and ElevenLabs can slot into the same script
- [~31 extra `AudioPlayer` lifecycles per round] → players are created per utterance and removed on completion; preload keeps start latency minimal
- [setTimeout scheduling drifts under JS-thread load] → same exposure class as the existing controller clock (Date.now-based look-ahead); tolerable at 100ms tick granularity

## Open Questions

- Final voice choice (Guy vs Christopher) and rate/pitch feel — settled by ear in the web preview; regenerate until right
