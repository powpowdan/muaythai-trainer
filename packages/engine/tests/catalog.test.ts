import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/catalog';

describe('move catalog integrity', () => {
  it('contains moves', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it('every entry has all fields populated', () => {
    for (const move of CATALOG) {
      expect(move.id, `${move.id || '(missing id)'}: id`).toBeTruthy();
      expect(['lead', 'rear', 'neutral'], `${move.id}: side`).toContain(move.side);
      expect(
        ['punch', 'kick', 'knee', 'elbow', 'defense', 'movement'],
        `${move.id}: type`,
      ).toContain(move.type);
      expect(['light', 'power'], `${move.id}: power`).toContain(move.power);
      expect(move.calloutText, `${move.id}: calloutText`).toBeTruthy();
      expect(move.displayText, `${move.id}: displayText`).toBeTruthy();
    }
  });

  it('has unique ids', () => {
    const ids = CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('callout text is speakable: numbers as words, lowercase words, slug-safe', () => {
    for (const move of CATALOG) {
      expect(move.calloutText, `${move.id}: not lowercase`).toBe(move.calloutText.toLowerCase());
      expect(move.calloutText, `${move.id}: must be lowercase words`).toMatch(/^[a-z]+( [a-z]+)*$/);
      expect(move.calloutText, `${move.id}: digits are not speakable`).not.toMatch(/\d/);
    }
  });

  it('covers the core Muay Thai move types', () => {
    const types = new Set(CATALOG.map((m) => m.type));
    for (const required of ['punch', 'kick', 'knee', 'elbow', 'defense', 'movement'] as const) {
      expect(types, `missing type ${required}`).toContain(required);
    }
  });

  it('punches are jab, double jab, cross, and hook (lead and rear share the word)', () => {
    const punches = CATALOG.filter((m) => m.type === 'punch');
    const ids = punches.map((m) => m.id).sort();
    expect(ids).toEqual(['cross', 'double-jab', 'jab', 'lead-hook', 'rear-hook']);
    expect(punches.filter((m) => m.calloutText === 'hook').length, 'both hooks say hook').toBe(2);
    for (const m of punches) {
      const expected = m.id === 'double-jab' ? 'dbl jab' : m.calloutText;
      expect(m.displayText, `${m.id}: unexpected display text`).toBe(expected);
    }
    expect(CATALOG.some((m) => m.id.includes('uppercut')), 'uppercuts removed').toBe(false);
  });

  it('multi-strike units declare durationUnits above one; everyone else defaults to one', () => {
    for (const move of CATALOG) {
      if (move.durationUnits === undefined) continue;
      expect(move.durationUnits, `${move.id}: durationUnits must exceed a single strike`).toBeGreaterThan(1);
    }
    const doubleJab = CATALOG.find((m) => m.id === 'double-jab');
    expect(doubleJab?.durationUnits, 'double-jab paces like ~1.5 strikes').toBe(1.5);
  });
});
