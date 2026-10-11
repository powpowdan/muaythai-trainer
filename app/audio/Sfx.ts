import { Platform } from 'react-native';
import {
  createAudioPlayer,
  requestNotificationPermissionsAsync,
  type AudioPlayer,
} from 'expo-audio';
import type { BellKind } from '@muaythai/engine';

const isWeb = Platform.OS === 'web';

export interface Sfx {
  playBell(kind: BellKind): void;
  /**
   * Start a session: activate the media foreground service via a silent
   * looping player and expose lock-screen controls. Returns true when the
   * user paused from the lock screen (polled by the controller).
   */
  startSession(): void;
  isExternallyPaused(): boolean;
  setPaused(paused: boolean): void;
  /** Update the notification/lock-screen title, e.g. "Round 2 — work". */
  setMetadata(title: string): void;
  endSession(): void;
}

export function createSfx(): Sfx {
  const bells: Record<BellKind, AudioPlayer> = {
    'round-start': createAudioPlayer(require('../assets/audio/bell-start.wav')),
    'round-end': createAudioPlayer(require('../assets/audio/bell-end.wav')),
    final: createAudioPlayer(require('../assets/audio/bell-final.wav')),
  };
  // Silent looping player keeps the media foreground service alive for the
  // whole session (TTS alone does not hold it) and carries lock-screen
  // controls wired to pause/resume via isExternallyPaused().
  const keepalive = createAudioPlayer(require('../assets/audio/silence.wav'));

  // A keepalive that never started or has errored must NOT read as an
  // external pause — otherwise an audio failure freezes the workout timer
  // on its first tick. Only a player that actually played and then paused
  // (lock-screen controls) counts as external.
  let everPlayed = false;
  let degraded = false;
  keepalive.addListener('playbackStatusUpdate', (status) => {
    if (status.error) {
      degraded = true;
      tryClearLockScreenControls();
      return;
    }
    if (status.playing) everPlayed = true;
  });

  function tryClearLockScreenControls(): void {
    if (isWeb) return;
    try {
      keepalive.clearLockScreenControls();
    } catch {
      // Best-effort — the service may already be gone.
    }
  }

  return {
    playBell(kind: BellKind) {
      const player = bells[kind];
      player.seekTo(0);
      player.play();
    },
    async startSession() {
      // Lock-screen controls, notification permissions and the media
      // foreground service are native-only concepts; web just plays audio.
      if (isWeb) return;
      try {
        // Android shows media controls in the notification shade only when the
        // POST_NOTIFICATIONS permission is granted.
        try {
          await requestNotificationPermissionsAsync();
        } catch {
          // Controls still work from inside the app without the permission.
        }
        keepalive.loop = true;
        keepalive.volume = 0;
        keepalive.setActiveForLockScreen(true, {
          title: 'Workout',
          artist: 'Muaythai Trainer',
        });
        keepalive.play();
      } catch (err) {
        // Degraded mode: no keepalive, no lock-screen controls — but the
        // session continues with timer and callouts unaffected.
        degraded = true;
        console.warn('[Sfx] media session failed to start; continuing without lock-screen controls', err);
        tryClearLockScreenControls();
      }
    },
    isExternallyPaused() {
      if (isWeb || degraded) return false;
      return everPlayed && keepalive.paused;
    },
    setPaused(paused: boolean) {
      if (isWeb) return;
      try {
        if (paused) {
          keepalive.pause();
        } else {
          keepalive.play();
        }
      } catch (err) {
        console.warn('[Sfx] keepalive transport failed', err);
      }
    },
    setMetadata(title: string) {
      if (isWeb || degraded) return;
      keepalive.updateLockScreenMetadata({
        title,
        artist: 'Muaythai Trainer',
      });
    },
    endSession() {
      try {
        keepalive.pause();
      } catch {
        // Best-effort teardown.
      }
      tryClearLockScreenControls();
      keepalive.remove();
      for (const player of Object.values(bells)) player.remove();
      // The preloaded voice-clip byte cache is intentionally kept so the
      // app-start warm-up survives across sessions.
    },
  };
}
