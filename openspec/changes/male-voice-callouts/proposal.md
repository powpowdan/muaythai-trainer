## Why

The callout voice must be male, on every device. Device TTS cannot guarantee that: default voices vary by engine (Google vs Samsung), gender isn't exposed in voice metadata, and quality differs per phone. Bundling pre-generated male voice clips removes the device from the equation entirely and, as a bonus, lets each callout word land on the strike beat instead of drifting at TTS's own pace.

## What Changes

- One-time generation pipeline (`scripts/gen-voice.mjs` using the free `msedge-tts` service, voice `en-US-GuyNeural` initially) producing ~31 MP3 clips into `app/assets/voice/` plus a statically-importable manifest (`app/audio/voice-manifest.ts`)
- Engine exports the authoritative clip list (`VOICE_CLIPS` mapping) derived from the catalog's callout texts plus round announcements ("round one"…"round twelve", "rest", "time") — the generator and the app share one source of truth
- New `Mp3Speaker` adapter implementing the existing `Speaker` seam: announcements play as single clips, combos play word-by-word at the engine's per-intensity strike tempo, with per-word TTS fallback for any missing clip
- Player constructs `Mp3Speaker` (with intensity-derived pacing) in place of the TTS speaker; TTS speaker remains as the in-adapter fallback

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `callout-playback`: adds requirements for voice consistency (identical bundled male voice on every device, no dependence on the device TTS engine) and graceful fallback to device TTS when a clip is unavailable, without stopping the session.

## Impact

- `packages/engine`: new `src/voice.ts` (clip-name mapping + list export) with unit tests; no changes to grammar/scheduler behavior
- `app/audio/`: new `Mp3Speaker.ts`, generated `voice-manifest.ts`; `player.tsx` construction site changes
- New dev dependency `msedge-tts` (generator only, not shipped); `app/assets/voice/*.mp3` adds ~1 MB to the bundle
- Bells and all other audio behavior unchanged
