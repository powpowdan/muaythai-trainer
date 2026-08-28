import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CATALOG, generateWorkout, type MoveType } from '@muaythai/engine';
import {
  DEFAULT_CONFIG,
  INTENSITIES,
  REST_SECONDS_OPTIONS,
  ROUND_SECONDS_OPTIONS,
  ROUNDS_RANGE,
  loadConfig,
  saveConfig,
  toWorkoutConfig,
  type SetupConfig,
} from './config';
import { setCurrentTimeline } from './session';

const GROUPS: { type: MoveType; label: string }[] = [
  { type: 'punch', label: 'Punches' },
  { type: 'kick', label: 'Kicks' },
  { type: 'knee', label: 'Knees' },
  { type: 'elbow', label: 'Elbows' },
  { type: 'defense', label: 'Defense' },
  { type: 'movement', label: 'Movement' },
];

const STRIKE_TYPES = new Set<MoveType>(['punch', 'kick', 'knee', 'elbow']);

export default function SetupScreen() {
  const router = useRouter();
  const [config, setConfig] = useState<SetupConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadConfig().then((stored) => {
      setConfig(stored);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) saveConfig(config);
  }, [config, loaded]);

  const disabled = useMemo(() => new Set(config.disabledMoveIds), [config.disabledMoveIds]);
  const strikeCount = CATALOG.filter((m) => STRIKE_TYPES.has(m.type) && !disabled.has(m.id)).length;

  const toggleMove = (id: string) => {
    setConfig((c) => ({
      ...c,
      disabledMoveIds: c.disabledMoveIds.includes(id)
        ? c.disabledMoveIds.filter((x) => x !== id)
        : [...c.disabledMoveIds, id],
    }));
  };

  const toggleGroup = (type: MoveType) => {
    const ids = CATALOG.filter((m) => m.type === type).map((m) => m.id);
    const allDisabled = ids.every((id) => disabled.has(id));
    setConfig((c) => ({
      ...c,
      disabledMoveIds: allDisabled
        ? c.disabledMoveIds.filter((id) => !ids.includes(id))
        : [...new Set([...c.disabledMoveIds, ...ids])],
    }));
  };

  const start = () => {
    if (strikeCount === 0) {
      Alert.alert('No strikes enabled', 'Enable at least one punch, kick, knee or elbow.');
      return;
    }
    const workout = generateWorkout(toWorkoutConfig(config, Date.now()));
    setCurrentTimeline(workout);
    router.push('/player');
  };

  const step = (value: number, options: readonly number[], delta: number): number => {
    const idx = options.indexOf(value);
    const next = Math.min(options.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + delta));
    return options[next];
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Section title="Rounds">
        <Stepper
          label="Rounds"
          value={String(config.rounds)}
          onMinus={() =>
            setConfig((c) => ({
              ...c,
              rounds: Math.max(ROUNDS_RANGE.min, c.rounds - 1),
            }))
          }
          onPlus={() =>
            setConfig((c) => ({
              ...c,
              rounds: Math.min(ROUNDS_RANGE.max, c.rounds + 1),
            }))
          }
        />
        <Stepper
          label="Round length"
          value={formatMinutes(config.roundSeconds)}
          onMinus={() => setConfig((c) => ({ ...c, roundSeconds: step(c.roundSeconds, ROUND_SECONDS_OPTIONS, -1) }))}
          onPlus={() => setConfig((c) => ({ ...c, roundSeconds: step(c.roundSeconds, ROUND_SECONDS_OPTIONS, 1) }))}
        />
        <Stepper
          label="Rest"
          value={`${config.restSeconds}s`}
          onMinus={() => setConfig((c) => ({ ...c, restSeconds: step(c.restSeconds, REST_SECONDS_OPTIONS, -1) }))}
          onPlus={() => setConfig((c) => ({ ...c, restSeconds: step(c.restSeconds, REST_SECONDS_OPTIONS, 1) }))}
        />
      </Section>

      <Section title="Intensity">
        <View style={styles.intensityRow}>
          {INTENSITIES.map((level) => (
            <Pressable
              key={level}
              style={[styles.intensityButton, config.intensity === level && styles.intensityActive]}
              onPress={() => setConfig((c) => ({ ...c, intensity: level }))}
            >
              <Text
                style={[
                  styles.intensityText,
                  config.intensity === level && styles.intensityTextActive,
                ]}
              >
                {level}
              </Text>
            </Pressable>
          ))}
        </View>
      </Section>

      {GROUPS.map((group) => {
        const moves = CATALOG.filter((m) => m.type === group.type);
        const allDisabled = moves.every((m) => disabled.has(m.id));
        return (
          <Section
            key={group.type}
            title={group.label}
            action={{ label: allDisabled ? 'all on' : 'all off', onPress: () => toggleGroup(group.type) }}
          >
            <View style={styles.moveGrid}>
              {moves.map((move) => (
                <View key={move.id} style={styles.moveRow}>
                  <Text style={styles.moveLabel}>{move.displayText}</Text>
                  <Switch
                    value={!disabled.has(move.id)}
                    onValueChange={() => toggleMove(move.id)}
                    trackColor={{ true: '#e11d48' }}
                  />
                </View>
              ))}
            </View>
          </Section>
        );
      })}

      <Pressable style={styles.startButton} onPress={start}>
        <Text style={styles.startButtonText}>Start workout</Text>
      </Pressable>
    </ScrollView>
  );
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatMinutes(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : formatSeconds(seconds);
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action && (
          <Pressable onPress={action.onPress} hitSlop={8}>
            <Text style={styles.sectionAction}>{action.label}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <Pressable style={styles.stepButton} onPress={onMinus} hitSlop={8}>
          <Text style={styles.stepButtonText}>−</Text>
        </Pressable>
        <Text style={styles.stepperValue}>{value}</Text>
        <Pressable style={styles.stepButton} onPress={onPlus} hitSlop={8}>
          <Text style={styles.stepButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  section: { backgroundColor: '#16161a', borderRadius: 16, padding: 16, gap: 12 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: '#f5f5f4', fontSize: 16, fontWeight: '600' },
  sectionAction: { color: '#e11d48', fontSize: 13, fontWeight: '600' },
  stepperRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stepperLabel: { color: '#a1a1aa', fontSize: 15 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#26262c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonText: { color: '#f5f5f4', fontSize: 20, lineHeight: 24 },
  stepperValue: { color: '#f5f5f4', fontSize: 16, minWidth: 64, textAlign: 'center', fontVariant: ['tabular-nums'] },
  intensityRow: { flexDirection: 'row', gap: 8 },
  intensityButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#26262c',
    alignItems: 'center',
  },
  intensityActive: { backgroundColor: '#e11d48' },
  intensityText: { color: '#a1a1aa', fontSize: 14, textTransform: 'capitalize' },
  intensityTextActive: { color: '#fff', fontWeight: '600' },
  moveGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '33.33%',
    paddingHorizontal: 4,
  },
  moveLabel: { color: '#d4d4d8', fontSize: 14, flex: 1 },
  startButton: {
    backgroundColor: '#e11d48',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  startButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
