import { Platform } from 'react-native';
import {
  clearAllPreloadedSources,
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
    },
    isExternallyPaused() {
      return isWeb ? false : keepalive.paused;
    },
    setPaused(paused: boolean) {
      if (isWeb) return;
      if (paused) {
        keepalive.pause();
      } else {
        keepalive.play();
      }
    },
    setMetadata(title: string) {
      if (isWeb) return;
      keepalive.updateLockScreenMetadata({
        title,
        artist: 'Muaythai Trainer',
      });
    },
    endSession() {
      keepalive.pause();
      if (!isWeb) keepalive.clearLockScreenControls();
      keepalive.remove();
      for (const player of Object.values(bells)) player.remove();
      clearAllPreloadedSources();
    },
  };
}
