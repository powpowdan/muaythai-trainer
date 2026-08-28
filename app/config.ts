import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Intensity, WorkoutConfig } from '@muaythai/engine';

const STORAGE_KEY = 'workout-config-v1';

/** The part of the config the setup screen owns; seed is minted per workout. */
export interface SetupConfig {
  rounds: number;
  roundSeconds: number;
  restSeconds: number;
  intensity: Intensity;
  disabledMoveIds: string[];
}

export const ROUNDS_RANGE = { min: 1, max: 12 } as const;
export const ROUND_SECONDS_OPTIONS = [60, 120, 180, 240, 300] as const;
export const REST_SECONDS_OPTIONS = [15, 30, 45, 60, 90, 120] as const;
export const INTENSITIES: Intensity[] = ['easy', 'moderate', 'hard'];

export const DEFAULT_CONFIG: SetupConfig = {
  rounds: 3,
  roundSeconds: 180,
  restSeconds: 60,
  intensity: 'moderate',
  disabledMoveIds: [],
};

export async function loadConfig(): Promise<SetupConfig> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<SetupConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: SetupConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Persistence is best-effort; a failed save must not break setup.
  }
}

export function toWorkoutConfig(config: SetupConfig, seed: number): WorkoutConfig {
  return { ...config, seed };
}
