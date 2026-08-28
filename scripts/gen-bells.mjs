import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'app', 'assets', 'audio');
const SAMPLE_RATE = 44100;

function bellSamples({ fundamental, strikes, duration }) {
  const total = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(total);
  const partials = [
    { ratio: 1.0, gain: 0.7, decay: 3.5 },
    { ratio: 2.76, gain: 0.35, decay: 6.0 },
    { ratio: 5.4, gain: 0.2, decay: 9.0 },
    { ratio: 8.93, gain: 0.1, decay: 14.0 },
  ];
  for (const at of strikes) {
    const start = Math.floor(at * SAMPLE_RATE);
    for (let i = start; i < total; i++) {
      const t = (i - start) / SAMPLE_RATE;
      let v = 0;
      for (const p of partials) {
        v += p.gain * Math.sin(2 * Math.PI * fundamental * p.ratio * t) * Math.exp(-p.decay * t);
      }
      const attack = Math.min(1, (i - start) / (0.004 * SAMPLE_RATE));
      samples[i] += v * attack;
    }
  }
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = peak > 0 ? 0.9 / peak : 1;
  return Array.from(samples, (s) => Math.max(-32768, Math.min(32767, Math.round(s * norm * 32767))));
}

function wavBuffer(samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

mkdirSync(OUT_DIR, { recursive: true });

const bells = [
  { file: 'bell-start.wav', opts: { fundamental: 880, strikes: [0], duration: 1.6 } },
  { file: 'bell-end.wav', opts: { fundamental: 660, strikes: [0], duration: 1.6 } },
  { file: 'bell-final.wav', opts: { fundamental: 880, strikes: [0, 0.35, 0.7], duration: 2.2 } },
  { file: 'silence.wav', opts: { fundamental: 0, strikes: [], duration: 0.6 } },
];

for (const { file, opts } of bells) {
  const samples =
    opts.strikes.length === 0
      ? new Array(Math.floor(SAMPLE_RATE * opts.duration)).fill(0)
      : bellSamples(opts);
  writeFileSync(join(OUT_DIR, file), wavBuffer(samples));
  console.log(`wrote ${file}`);
}
