import * as Speech from 'expo-speech';
import { createAudioPlayer, preload, type AudioPlayer } from 'expo-audio';
import { slug } from '@muaythai/engine';
import { VOICE_CLIPS } from './voice-manifest';
import type { Speaker } from './Speaker';

/**
 * Speaker backed by bundled male-voice MP3 clips. Combos play word-by-word
 * at the workout's strike tempo; announcements play as single clips. Any
 * text without clips falls back to device TTS for the whole utterance.
 *
 * Each clip is played by a pooled, lazily-created AudioPlayer replayed via
 * seekTo(0) + play(). A player must NEVER be created per word: expo-audio
 * releases native players only on JS GC, so per-word players leak an open
 * AudioTrack each and exhaust Android's per-app track limit (~32) about 90
 * seconds into a moderate session.
 */
export function createMp3Speaker(strikeSeconds: number): Speaker {
  const pool = new Map<string, AudioPlayer>();
  const pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

  const playClip = (name: string): boolean => {
    const source = VOICE_CLIPS[name];
    if (source === undefined) return false;
    let player = pool.get(name);
    if (!player) {
      player = createAudioPlayer(source);
      pool.set(name, player);
    }
    player.seekTo(0);
    player.play();
    return true;
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
      pendingTimeouts.length = 0;
      // Paused pool players stay usable; the next playClip() seeks to 0.
      for (const player of pool.values()) player.pause();
      Speech.stop();
    },
    dispose() {
      for (const t of pendingTimeouts) clearTimeout(t);
      pendingTimeouts.length = 0;
      for (const player of pool.values()) {
        player.pause();
        player.remove();
      }
      pool.clear();
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
