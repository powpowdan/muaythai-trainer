## Why

On device, the voice dies ~90 seconds into every session (text keeps updating, audio goes silent), the app sometimes crashes natively, and once audio has failed, a restarted session never starts its timer until the whole app is killed. Root cause: `Mp3Speaker` creates a new native audio player (ExoPlayer + MediaSession + AudioTrack) for every spoken word, and expo-audio's `remove()` only forgets the JS reference — native release happens on JS GC, which never runs because the status-listener closure retains the wrapper in the global event registry. At moderate intensity that is ~1 leaked AudioTrack per ~3s, hitting Android's per-app track ceiling (~32) at almost exactly the 90-second mark. The keepalive player then can't start either, and the controller mistakes "failed to play" for "user paused" (`isExternallyPaused()`), freezing the timer on its first tick.

## What Changes

- Rewrite `Mp3Speaker` to use a fixed pool of long-lived players — one per bundled voice clip (the same pattern the round bells already use) — replayed via `seekTo(0)` + `play()` instead of per-word player creation. No per-word allocation, no release timers, no status listeners.
- Make lock-screen pause detection audio-failure-aware: `isExternallyPaused()` (or its caller) SHALL distinguish an external user pause from a keepalive player that failed to start, so an audio subsystem failure can never freeze the timeline timer.
- Handle `PlaybackController.start()` failures: surface setup errors instead of silently leaving a dead screen ("No workout in session" / frozen timer).
- Session teardown stops removing players that a pool reuses; `clearAllPreloadedSources()` is kept only where it does not defeat warm-up.

No user-visible behavior changes in the happy path: same voice, same word-level beat timing, same bells, same controls.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `callout-playback`: Add a resource-boundedness requirement — callouts must remain audible for an entire multi-round session and across back-to-back sessions, with a bounded number of native audio players regardless of workout length or intensity. Existing beat-timing, fallback, and bell requirements are unchanged.
- `workout-player`: Add a requirement that the timeline timer runs independently of audio subsystem health — audio init or playback failure must never block the timer from starting or stall it mid-session, and errors must be surfaced rather than silently swallowed.

## Impact

- `app/audio/Mp3Speaker.ts` — full rewrite to pooled players; `stop()`/`warmUp()` semantics unchanged from callers' perspective.
- `app/audio/Sfx.ts` — `isExternallyPaused()` must not report `true` for a player that never successfully started; minor teardown adjustments.
- `app/playback/PlaybackController.ts` — guard the self-pause path against failed-playback false positives; make `start()` failure observable.
- `app/player.tsx` — catch controller start errors and surface them.
- No engine changes; no dependency changes. expo-audio version stays as-is (its `remove()` semantics are worked around, not fixed).
- Verification requires a device (or emulator): full 3-round session + back-to-back restart, watching `adb logcat` for AudioTrack errors and `dumpsys media.audio_flinger` for track-count stability.
