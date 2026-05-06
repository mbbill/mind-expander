import { describe, expect, it } from 'vitest';
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  BUCKET_VIS_TOKEN,
  classifyVisibility,
  isRealVisibility,
} from '../src/analysis/visibility.ts';
import { colorForVisibility } from '../src/view/encoding.ts';

describe('classifyVisibility', () => {
  it('maps the canonical extractor tokens onto the five buckets', () => {
    expect(classifyVisibility('pub')).toBe('pub');
    expect(classifyVisibility('pub(crate)')).toBe('pub_crate');
    expect(classifyVisibility('pub(super)')).toBe('pub_super');
    expect(classifyVisibility('priv')).toBe('private');
    expect(classifyVisibility('pub(self)')).toBe('private');
  });

  it('routes any `pub(in ...)` form into pub_in_path', () => {
    expect(classifyVisibility('pub(in crate::a)')).toBe('pub_in_path');
    expect(classifyVisibility('pub(in self::nested::path)')).toBe('pub_in_path');
  });

  it('falls back to private for unknown visibility strings', () => {
    // Defensive default — anything we don't recognise is treated as
    // module-local rather than public.
    expect(classifyVisibility('something-weird')).toBe('private');
  });
});

describe('isRealVisibility', () => {
  it('rejects extractor sentinels like <orphan-impl>', () => {
    expect(isRealVisibility('<orphan-impl>')).toBe(false);
    expect(isRealVisibility('<unknown>')).toBe(false);
  });

  it('accepts real visibility tokens', () => {
    expect(isRealVisibility('pub')).toBe(true);
    expect(isRealVisibility('pub(crate)')).toBe(true);
    expect(isRealVisibility('priv')).toBe(true);
  });
});

describe('BUCKET tables', () => {
  it('BUCKET_ORDER lists each bucket exactly once, public-first', () => {
    expect(BUCKET_ORDER).toEqual(['pub', 'pub_crate', 'pub_super', 'pub_in_path', 'private']);
    expect(new Set(BUCKET_ORDER).size).toBe(BUCKET_ORDER.length);
  });

  it('BUCKET_LABEL ends in " fn" so rows read as functions, not types', () => {
    for (const b of BUCKET_ORDER) {
      expect(BUCKET_LABEL[b].endsWith(' fn') || BUCKET_LABEL[b] === 'local fn').toBe(true);
    }
  });

  it('BUCKET_VIS_TOKEN feeds back through classifyVisibility to the same bucket', () => {
    // Round-trip: each bucket's representative token must classify back to
    // that bucket. Catches drift between the table and the classifier.
    for (const b of BUCKET_ORDER) {
      expect(classifyVisibility(BUCKET_VIS_TOKEN[b])).toBe(b);
    }
  });
});

describe('colorForVisibility', () => {
  it('returns distinct colors for each bucket', () => {
    const colors = new Set<string>();
    for (const b of BUCKET_ORDER) colors.add(colorForVisibility(BUCKET_VIS_TOKEN[b]));
    // All five buckets must have unique colors so the dot is unambiguous.
    expect(colors.size).toBe(BUCKET_ORDER.length);
  });

  it('returns a valid hex color even for unknown tokens (defensive)', () => {
    const c = colorForVisibility('???');
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
