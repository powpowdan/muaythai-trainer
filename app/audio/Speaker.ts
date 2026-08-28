import * as Speech from 'expo-speech';

export interface Speaker {
  /** Queue one utterance. Numbers-as-words text, single combo per call. */
  speak(text: string): void;
  /** Flush everything queued (used on pause/end). */
  stop(): void;
  /** Initialize the TTS engine so the first real callout is not delayed. */
  warmUp(): void;
}

export function createSpeaker(): Speaker {
  return {
    speak(text: string) {
      Speech.speak(text, {
        language: 'en-US',
        rate: 1.15,
        pitch: 1.0,
        volume: 1.0,
      });
    },
    stop() {
      Speech.stop();
    },
    warmUp() {
      Speech.speak(' ', { volume: 0 });
    },
  };
}
