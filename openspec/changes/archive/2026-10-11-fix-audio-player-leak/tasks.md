## 1. Mp3Speaker pool rewrite

- [x] 1.1 Rewrite `app/audio/Mp3Speaker.ts` around a lazily-created per-clip player pool (`Map<string, AudioPlayer>` keyed by clip name from `VOICE_CLIPS`): `playClip(name)` fetches/creates the pooled player and replays it with `seekTo(0)` + `play()`; delete the per-word `createAudioPlayer`, `activePlayers`, `releaseTimeouts`, the 5s `CLIP_RELEASE_BACKSTOP_MS` backstop, and all `playbackStatusUpdate` listeners
- [x] 1.2 Update `stop()` in the same file: clear pending stagger timeouts and `pause()` every pooled player (pool survives for session reuse); keep `Speech.stop()` for the TTS fallback path; keep `speak()` word-stagger scheduling (`i * strikeSeconds * 1000`) and per-utterance TTS fallback unchanged
- [x] 1.3 Add pool teardown: a `dispose()`-style path (or cleanup invoked when the player screen unmounts) that pauses and `remove()`s every pooled player; keep `warmUp()` byte-cache preloading as-is
- [x] 1.4 Verify with `npm run typecheck` that the `Speaker` interface (app/audio/Speaker.ts) still type-checks unchanged; adjust the interface only if teardown requires it

## 2. Keepalive failure vs external pause

- [x] 2.1 In `app/audio/Sfx.ts`, make `isExternallyPaused()` return true only when the keepalive has previously started playing successfully and is now paused (e.g. track an `everPlayed`/started flag from the first successful play); a keepalive that never started or errored must read as "not externally paused"
- [x] 2.2 Add degraded-mode handling in `Sfx`: if `startSession()` or the keepalive fails, clear lock-screen activation and continue without controls instead of throwing (log to console; no crash path)

## 3. Start-failure surfacing

- [x] 3.1 In `app/playback/PlaybackController.ts`, wrap `start()`'s audio setup (`configureAudio()`, `sfx.startSession()`) in try/catch; on failure, still start the timeline interval and publish state, with a `startError`-style flag on `PlaybackState` (keep the timer running per specs/workout-player delta)
- [x] 3.2 In `app/player.tsx`, render the start error state (visible message + existing End control) when the controller reports it; ensure the effect cleanup still runs `end()` so teardown is symmetric on the failure path
- [x] 3.3 Guard `start()` against the unmount race: bail before publish/setInterval when `end()` already ran during async audio setup, so fast back-navigation after Start can't leave an orphaned ticking interval speaking into a disposed speaker; verify with `npm run typecheck`

## 4. Teardown adjustments

- [x] 4.1 In `app/audio/Sfx.ts` `endSession()`, drop the `clearAllPreloadedSources()` call so the app-start warm-up byte cache survives across sessions; keep keepalive/bell `pause()` + `remove()` teardown
- [x] 4.2 Confirm no other caller depends on `clearAllPreloadedSources` semantics (search app/ for usages)

## 5. Verification

- [x] 5.1 `npm run typecheck` passes; `npm run test:engine` (engine untouched) still green
- [ ] 5.2 Device run: full default workout (3 rounds × 180s + rests) with `adb logcat` filtered for AudioTrack/AudioFlinger errors — zero track-creation failures, voice audible through all rounds (spec: voice survives past ninety seconds)
- [ ] 5.3 Device run: hard-intensity multi-round session; `adb shell dumpsys media.audio_flinger` shows live track count plateauing at pool size, flat across the session (spec: bounded native audio usage)
- [ ] 5.4 Device run: end a session mid-round → immediately start a new one in the same process — second session's timer starts and callouts are audible (specs: back-to-back sessions keep voice; timer recovers after degraded prior session)
- [ ] 5.5 Device run: lock-screen pause/resume during a healthy session still pauses and resumes the workout (no regression to external-pause detection)
- [ ] 5.6 Manual smoke of TTS fallback: temporarily undisable a missing-clip text path (or use a debug utterance) and confirm device TTS speaks it and the session continues
