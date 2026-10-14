import * as Speech from 'expo-speech';

export interface Speaker {
  /**
   * Queue one utterance. Numbers-as-words text, single combo per call.
   * Optional per-word weights (parallel to the comma-split words) stretch
   * multi-strike words like "double jab": each following word starts after
   * the preceding words' weighted durations, not merely word index × tempo.
   */
  speak(text: string, wordWeights?: number[]): void;
  /** Flush everything queued (used on pause/end). */
  stop(): void;
  /** Release all underlying resources (used at session end). */
  dispose(): void;
  /** Initialize the TTS engine so the first callout is not delayed. */
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
    dispose() {
      Speech.stop();
    },
    warmUp() {
      Speech.speak(' ', { volume: 0 });
    },
  };
}
