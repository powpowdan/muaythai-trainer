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

  it('callout text is speakable: numbers as words, single words, lowercase', () => {
    for (const move of CATALOG) {
      expect(move.calloutText, `${move.id}: not lowercase`).toBe(move.calloutText.toLowerCase());
      expect(move.calloutText, `${move.id}: must be a single word`).toMatch(/^[a-z]+$/);
      expect(move.calloutText, `${move.id}: digits are not speakable`).not.toMatch(/\d/);
    }
  });

  it('covers the core Muay Thai move types', () => {
    const types = new Set(CATALOG.map((m) => m.type));
    for (const required of ['punch', 'kick', 'knee', 'elbow', 'defense', 'movement'] as const) {
      expect(types, `missing type ${required}`).toContain(required);
    }
  });

  it('punch numbers one through six exist with digit display text', () => {
    const punches = CATALOG.filter((m) => m.type === 'punch');
    const byCallout = new Map(punches.map((m) => [m.calloutText, m]));
    for (const word of ['one', 'two', 'three', 'four', 'five', 'six']) {
      expect(byCallout.has(word), `missing punch ${word}`).toBe(true);
    }
    for (const m of punches) {
      expect(m.displayText, `${m.id}: punch display should be a digit`).toMatch(/^\d$/);
    }
  });
});
