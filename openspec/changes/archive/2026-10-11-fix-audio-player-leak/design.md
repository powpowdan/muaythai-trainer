## Context

`Mp3Speaker` (app/audio/Mp3Speaker.ts) speaks every word by creating a fresh expo-audio `AudioPlayer` and "releasing" it via `player.remove()` plus a 5s backstop timer. In expo-audio (~57.0.4) on Android, `remove()` only drops the module-registry entry (`AudioModule.kt` `Function("remove")` → `players.remove(id)`); the native ExoPlayer, its MediaSession, and its open AudioTrack are released only when the JS `SharedObject` is finalized by GC — which never happens, because the `playbackStatusUpdate` listener closure is retained by the global event registry. One leaked AudioTrack per spoken word at ~1 per 3s hits Android's per-app track ceiling (~32 on many devices) at ≈90s, killing new audio (voice death, occasional native crash) and making the next session's keepalive fail to start, which the controller misreads as an external pause and freezes the timer (`PlaybackController.tick` → `sfx.isExternallyPaused()` → `this.pause()`). The round bells already demonstrate the correct pattern: three long-lived players replayed with `seekTo(0)` + `play()` (app/audio/Sfx.ts).

## Goals / Non-Goals

**Goals:**
- Zero native audio player allocation during a round: all word/announcement clips come from a fixed pool sized by the clip vocabulary (~28 entries).
- Timer resilience: audio failures never block `start()`, never self-pause the timeline, and are surfaced in the UI.
- Preserve all existing observable behavior: word-level beat timing, TTS fallback, bells, transport controls, lock-screen controls in the healthy path.

**Non-Goals:**
- Patching or forking expo-audio (its `remove()`/GC semantics are worked around, not fixed).
- Changing engine output, clip generation, or the voice itself.
- iOS support (app ships Android + web only).
- Any new error-telemetry/logging infrastructure beyond a visible error state.

## Decisions

### D1: Per-clip player pool, lazy creation, session lifetime

One `AudioPlayer` per `VOICE_CLIPS` entry, created lazily on first use and reused via `seekTo(0)` → `play()`. Lifetime = the `Mp3Speaker` instance (one per session/player screen mount), torn down in `stop()`-adjacent cleanup.

- Why not a per-word single player with `replace()`? `replace()` swaps the media item; rapid sequential words would re-prepare the source on each beat and can truncate a still-sounding clip when the same word repeats (jab-jab). Per-clip pooling reproduces today's overlap semantics exactly.
- Why not eager creation of all ~28 players? Lazy keeps cold start cheap and matches the 250ms first-callout budget (only the first word of round 1 pays player construction; `preload()` byte-cache still warms decoders at app start via `warmUp()`).
- Why not an app-lifetime singleton pool? Session lifetime guarantees a known-clean teardown point and matches how `Sfx` bells live per session; bounded churn (≤28 players per session) is fine because players created once per session never approach the track ceiling. Can be promoted to a singleton later without changing callers.

### D2: Pool teardown without `clearAllPreloadedSources`

At session end the pool players get `pause()` + `remove()`; the byte-cache (`preload`) is NOT cleared per session anymore. `clearAllPreloadedSources()` in `Sfx.endSession()` defeated the app-start warm-up for every session after the first. The byte cache is small (MP3s total well under a few MB) and lives for the process anyway.

### D3: Keepalive failure ≠ external pause

`Sfx.isExternallyPaused()` becomes "was playing and then externally paused": `Sfx` tracks an `everStartedSuccessfully` flag (set once the keepalive reports playing) and only then consults `keepalive.paused`. Additionally, if the keepalive errors or never starts, `Sfx` enters a degraded mode: no lock-screen controls, timer unaffected. This keeps the existing lock-screen-pause contract (spec: "Playback survives backgrounding") while closing the false-positive that froze the timer.

- Alternative rejected: checking `keepalive.paused` only after a delay — still heuristic, still self-pauses on transient errors.

### D4: `start()` failure surfaced through state

`PlaybackController.start()` already awaits `configureAudio()`; the controller wraps the whole startup in try/catch and publishes an error-bearing state (or invokes `onEnd` with a failure flag) so `player.tsx` can show an actionable message. The player screen binds this to a visible error row plus the existing End control; no new navigation. `start()` also re-checks `ended` after its awaits so an unmount racing the async audio setup cannot create an orphaned interval speaking into a disposed speaker.

### D5: `stop()` semantics with a pool

`Speaker.stop()` (user pause, skip, end) pauses all pool players (a paused pool player is instantly reusable; `seekTo(0)` on next play) and clears pending stagger timeouts. TTS fallback path (`Speech.stop()`) unchanged. The 5s backstop timers, `didJustFinish` listeners, and `activePlayers` bookkeeping are deleted outright.

## Risks / Trade-offs

- [Clip still sounding when same clip is called again quickly (jab-jab at hard tempo 0.6s)] → `seekTo(0)` restart truncates the tail; identical to intent (a new strike call replaces the old one). Current per-word behavior is equivalent.
- [expo-audio `seekTo` on an ENDED player edge cases] → Bells have used exactly `seekTo(0); play()` in production since MVP without issue; same primitives, same module.
- [28 pooled players each construct a native MediaSession in expo-audio] → Same as today's bells (3/4 long-lived players with sessions); bounded and constant, and players are removed at session end. Track ceiling is about open AudioTracks, not MediaSessions; pooled count is far below it.
- [Residual GC-deferred release of pooled players after `remove()` at session end] → Bounded by pool size (≤28 + 4), not by session length; not reachable as a leak.
- [Device variance in the ~32 track limit] → Pooling removes the dependency on the limit entirely; verification still includes a logcat sweep to confirm no `AudioTrack` creation errors.

## Migration Plan

Single PR, backwards compatible (no persisted state, no API changes). Rollback = revert. Post-merge device verification: full default workout (3×180s + rest), hard-intensity workout, end-mid-round → immediate restart, and lock-screen pause/resume — with `adb logcat` watching for AudioTrack errors and `dumpsys media.audio_flinger` confirming a flat live-track count.

## Open Questions

- None blocking. (Optional follow-up: promoting the clip pool to an app-lifetime singleton — independent of this change.)
