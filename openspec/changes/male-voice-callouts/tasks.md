## 1. Engine clip vocabulary (test-first)

- [x] 1.1 Write failing tests for `src/voice.ts`: every distinct catalog callout word has a slug; round announcements one–twelve plus "rest" and "time" are covered; `slug()` maps "round three" → "round-three", single words unchanged; the clip set covers every `calloutText` and announcement the scheduler can emit
- [x] 1.2 Implement `voice.ts` (slug + clip list export); tests pass

## 2. Generation pipeline

- [x] 2.1 Add `msedge-tts` dev dependency (Windows-side npm); write `scripts/gen-voice.mjs` that generates one MP3 per clip from the engine vocabulary into `app/assets/voice/` and writes `app/audio/voice-manifest.ts` with static requires
- [x] 2.2 Generate the clip set with `en-US-GuyNeural`; verify all files non-empty and manifest lists every clip

## 3. Mp3Speaker adapter

- [x] 3.1 Implement `app/audio/Mp3Speaker.ts`: manifest-driven lookup, per-word combo scheduling at injected strike tempo, announcement single-clips, preload at warm-up, timeout/player cleanup on stop, whole-utterance TTS fallback for missing clips
- [x] 3.2 Wire into `player.tsx` (construct with `INTENSITY_PARAMS[intensity].strikeSeconds` from the timeline config); keep TTS speaker only as the adapter's internal fallback

## 4. Verification

- [x] 4.1 Gates: `tsc --noEmit`, engine tests, web export bundle
- [ ] 4.2 Ear check in web preview: voice is male, combo words land on the beat, announcements sound natural; regenerate with adjusted voice/rate if not
