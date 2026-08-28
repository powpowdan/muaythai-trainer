import * as Speech from 'expo-speech';
import { createAudioPlayer, preload, type AudioPlayer } from 'expo-audio';
import { slug } from '@muaythai/engine';
import { VOICE_CLIPS } from './voice-manifest';
import type { Speaker } from './Speaker';

const CLIP_RELEASE_BACKSTOP_MS = 5000;

/**
 * Speaker backed by bundled male-voice MP3 clips. Combos play word-by-word
 * at the workout's strike tempo; announcements play as single clips. Any
 * text without clips falls back to device TTS for the whole utterance.
 */
export function createMp3Speaker(strikeSeconds: number): Speaker {
  const pendingTimeouts: ReturnType<typeof setTimeout>[] = [];
  const activePlayers: AudioPlayer[] = [];
  const releaseTimeouts: ReturnType<typeof setTimeout>[] = [];

  const playClip = (name: string): boolean => {
    const source = VOICE_CLIPS[name];
    if (source === undefined) return false;
    const player = createAudioPlayer(source);
    activePlayers.push(player);
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) releasePlayer(player);
    });
    // Backstop in case the finish event never fires (e.g. clip replaced).
    releaseTimeouts.push(
      setTimeout(() => releasePlayer(player), CLIP_RELEASE_BACKSTOP_MS),
    );
    player.play();
    return true;
  };

  const releasePlayer = (player: AudioPlayer): void => {
    const idx = activePlayers.indexOf(player);
    if (idx >= 0) activePlayers.splice(idx, 1);
    player.remove();
  };

  return {
    speak(text: string) {
      const words = text.split(',').map((w) => w.trim());
      const names = words.map(slug);
      const allClipsReady = names.length > 0 && names.every((n) => n in VOICE_CLIPS);
      if (!allClipsReady) {
        // Fallback is per-utterance so one combo never mixes two voices.
        Speech.speak(text, { language: 'en-US', rate: 1.15 });
        return;
      }
      names.forEach((name, i) => {
        pendingTimeouts.push(
          setTimeout(() => playClip(name), i * strikeSeconds * 1000),
        );
      });
    },
    stop() {
      for (const t of pendingTimeouts) clearTimeout(t);
      for (const t of releaseTimeouts) clearTimeout(t);
      pendingTimeouts.length = 0;
      releaseTimeouts.length = 0;
      for (const player of [...activePlayers]) {
        player.pause();
        releasePlayer(player);
      }
      Speech.stop();
    },
    warmUp() {
      for (const source of Object.values(VOICE_CLIPS)) {
        try {
          // preload() returns void on web and possibly a Promise on native —
          // handle both, and never let warm-up break app start.
          const result: unknown = preload(source);
          if (result instanceof Promise) result.catch(() => undefined);
        } catch {
          // Warm-up is best-effort; playback falls back to TTS on failure.
        }
      }
    },
  };
}
