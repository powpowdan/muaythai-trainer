import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createSpeaker } from './audio/Speaker';
import { createMp3Speaker } from './audio/Mp3Speaker';

export default function RootLayout() {
  useEffect(() => {
    // Warm both audio paths at app start: device TTS (fallback) and the
    // bundled voice clips, so the first callout of a session meets the
    // 250ms timing budget.
    createSpeaker().warmUp();
    createMp3Speaker(0.75).warmUp();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#16161a' },
          headerTintColor: '#f5f5f4',
          contentStyle: { backgroundColor: '#0c0c0e' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Muaythai Trainer' }} />
        <Stack.Screen name="player" options={{ title: 'Workout' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
