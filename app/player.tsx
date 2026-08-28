import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { setAudioModeAsync } from 'expo-audio';
import { createSpeaker } from './audio/Speaker';
import { createSfx } from './audio/Sfx';
import { PlaybackController, type PlaybackState } from './playback/PlaybackController';
import { clearCurrentTimeline, takeCurrentTimeline } from './session';

export default function PlayerScreen() {
  const router = useRouter();
  const controllerRef = useRef<PlaybackController | null>(null);
  const [state, setState] = useState<PlaybackState | null>(null);

  useEffect(() => {
    const timeline = takeCurrentTimeline();
    if (!timeline) return;

    const controller = new PlaybackController(
      timeline,
      {
        speaker: createSpeaker(),
        sfx: createSfx(),
        configureAudio: () =>
          setAudioModeAsync({
            playsInSilentMode: true,
            shouldPlayInBackground: true,
            interruptionMode: 'mixWithOthers',
          }),
      },
      setState,
      () => {
        clearCurrentTimeline();
        router.back();
      },
    );
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.end();
      controllerRef.current = null;
    };
  }, [router]);

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.hint}>No workout in session.</Text>
      </View>
    );
  }

  const phaseLabel = state.phase === 'work' ? 'Work' : state.phase === 'rest' ? 'Rest' : 'Done';

  return (
    <View style={styles.container}>
      <Text style={styles.roundLabel}>
        Round {state.round} / {state.totalRounds} · {phaseLabel}
      </Text>
      <Text style={styles.timer}>{formatSeconds(state.remainingSeconds)}</Text>

      <View style={styles.comboArea}>
        <Text style={styles.currentCombo}>{state.currentComboText ?? '—'}</Text>
        {state.recentCombos.slice(0, 2).map((combo, i) => (
          <Text key={`${combo}-${i}`} style={[styles.recentCombo, i > 0 && styles.recentComboOlder]}>
            {combo}
          </Text>
        ))}
      </View>

      <View style={styles.controls}>
        <Pressable
          style={[styles.controlButton, state.isPaused ? styles.controlPrimary : styles.controlSecondary]}
          onPress={() => (state.isPaused ? controllerRef.current?.resume() : controllerRef.current?.pause())}
        >
          <Text style={state.isPaused ? styles.controlPrimaryText : styles.controlSecondaryText}>
            {state.isPaused ? 'Resume' : 'Pause'}
          </Text>
        </Pressable>
        <Pressable style={[styles.controlButton, styles.controlSecondary]} onPress={() => controllerRef.current?.skip()}>
          <Text style={styles.controlSecondaryText}>Skip</Text>
        </Pressable>
        <Pressable style={[styles.controlButton, styles.controlDanger]} onPress={() => controllerRef.current?.end()}>
          <Text style={styles.controlDangerText}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 24,
    paddingTop: 48,
    paddingBottom: 36,
  },
  roundLabel: {
    color: '#a1a1aa',
    fontSize: 16,
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  timer: {
    color: '#f5f5f4',
    fontSize: 88,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  comboArea: { alignItems: 'center', gap: 6, minHeight: 120, justifyContent: 'center' },
  currentCombo: { color: '#fff', fontSize: 34, fontWeight: '700', letterSpacing: 1 },
  recentCombo: { color: '#8e8e96', fontSize: 20, fontVariant: ['tabular-nums'] },
  recentComboOlder: { color: '#52525b', fontSize: 16 },
  controls: { flexDirection: 'row', gap: 10, width: '100%' },
  controlButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  controlPrimary: { backgroundColor: '#e11d48' },
  controlPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  controlSecondary: { backgroundColor: '#26262c' },
  controlSecondaryText: { color: '#f5f5f4', fontSize: 15, fontWeight: '600' },
  controlDanger: { backgroundColor: '#2a1215' },
  controlDangerText: { color: '#fb7185', fontSize: 15, fontWeight: '600' },
  hint: { color: '#71717a', fontSize: 14 },
});
