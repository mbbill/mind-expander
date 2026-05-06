// Text-width measurement via an offscreen canvas. Canvas's text shaping
// matches what SVG renders at the same font/size, so the result is
// pixel-exact for laying out adjacent SVG elements (e.g. arrow source x
// pinned to a field name's right edge).
//
// Per-string memoization: identifiers recur heavily across renders,
// crates, and re-layouts, so caching is the easy win that makes the
// per-call cost effectively zero. Cache survives the whole session.

const FALLBACK_CHAR_W = 7;

export type TextMeasurer = (text: string) => number;

/**
 * Build a measurer bound to a single CSS `font` string (e.g.
 * `"12px -apple-system, ..."`). Returns a callable that's safe to invoke
 * O(N) times per layout — the canvas API call is fast and the result is
 * memoized by string. Falls back to a flat-per-char approximation in
 * non-DOM environments (e.g. tests) so callers don't have to special-case.
 */
export function createTextMeasurer(font: string): TextMeasurer {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (ctx) ctx.font = font;
  const cache = new Map<string, number>();
  return (text: string) => {
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const w = ctx ? ctx.measureText(text).width : text.length * FALLBACK_CHAR_W;
    cache.set(text, w);
    return w;
  };
}
