import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createSpeaker } from './audio/Speaker';

export default function RootLayout() {
  useEffect(() => {
    // Warm the TTS engine at app start so the first callout of a session
    // meets the 250ms timing budget (design D4).
    createSpeaker().warmUp();
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
