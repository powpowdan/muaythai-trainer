import { describe, expect, it } from 'vitest';
import { ANNOUNCEMENT_TEXTS, MOVE_VOICE_TEXTS, slug, VOICE_CLIP_TEXTS } from '../src/voice';
import { CATALOG } from '../src/catalog';

describe('voice clip vocabulary', () => {
  it('slug maps phrases to kebab filenames, single words unchanged', () => {
    expect(slug('one')).toBe('one');
    expect(slug('round three')).toBe('round-three');
    expect(slug('rest')).toBe('rest');
  });

  it('covers every distinct catalog callout text', () => {
    const distinct = new Set(CATALOG.map((m) => m.calloutText));
    for (const text of distinct) {
      expect(MOVE_VOICE_TEXTS, `missing clip text "${text}"`).toContain(text);
    }
    // shared words collapse: two kicks, two teeps, two knees, two elbows
    expect(MOVE_VOICE_TEXTS.length).toBeLessThan(CATALOG.length);
  });

  it('includes round announcements one through twelve, rest, and time', () => {
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']) {
      expect(ANNOUNCEMENT_TEXTS).toContain(`round ${n}`);
    }
    expect(ANNOUNCEMENT_TEXTS).toContain('rest');
    expect(ANNOUNCEMENT_TEXTS).toContain('time');
  });

  it('full clip set has unique slugs and only lowercase kebab names', () => {
    const slugs = VOICE_CLIP_TEXTS.map(slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) {
      expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
