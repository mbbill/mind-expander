import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function cssRule(selector: string): string {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(html);
  return match?.[1] ?? '';
}

function treeSource(): string {
  return readFileSync(new URL('../src/view/tree.ts', import.meta.url), 'utf8');
}

function arrowDisambigSource(): string {
  return readFileSync(new URL('../src/view/arrow_disambig.ts', import.meta.url), 'utf8');
}

describe('selected arrow styling', () => {
  it('does not change arrow stroke width on selection', () => {
    expect(cssRule('#tree g.arrows path.visible.highlighted')).not.toContain('stroke-width');
    expect(cssRule('#tree g.arrows path.visible.call.highlighted')).not.toContain('stroke-width');
  });

  it('keeps idle canonical ownership arrows shallower than selected arrows', () => {
    expect(
      cssRule('#tree g.arrows path.visible.canonical:not(.call):not(.reexport):not(.highlighted)'),
    ).toContain('opacity: 0.45');
    expect(cssRule('#tree g.arrows path.visible.highlighted')).toContain('opacity: 1');
  });

  it('does not override the stroke color on highlighted call arrows', () => {
    // Call arrows get their stroke from the renderer based on locality
    // (grey for local, blue for external). The highlight state must only
    // bump opacity; if the CSS forced a stroke here, external arrows would
    // flip to grey when selected and lose their locality cue.
    const rule = cssRule('#tree g.arrows path.visible.call.highlighted');
    expect(rule).toContain('opacity: 1');
    expect(rule).not.toContain('stroke:');
  });

  it('uses a fixed-size marker for hovered arrows', () => {
    expect(cssRule('#tree g.arrows g.arrow:hover path.visible')).toContain(
      'marker-end: url(#sf-arrow-hover)',
    );
    expect(treeSource()).toContain("define('sf-arrow-hover', { markerUnits: 'userSpaceOnUse'");
  });

  it('does not pin member type text open on selection', () => {
    const source = treeSource();
    expect(source).not.toContain('if (isSelected) tyText.style');
    expect(source).not.toContain('click-to-stay');
  });

  it('renders a solid background behind hovered member type text', () => {
    const source = treeSource();
    expect(source).toContain("attr('class', 'field-ty-bg')");
    expect(source).toContain('sizeTypeHintBackground(tyText, tyBg)');
  });

  it('has a callable debug panel driven by attached call facts', () => {
    const source = treeSource();
    expect(cssRule('#callable-debug')).toContain('position: fixed');
    expect(source).toContain('function showCallableDebugPanel');
    // Debug overlay gates on layoutDebugEnabled() first, then dispatches
    // to the per-row-kind variant. Pin both the gate and the dispatch.
    expect(source).toMatch(/layoutDebugEnabled\(\)[\s\S]{0,200}?showCallableDebugPanel/);
    expect(source).toContain('row.callRefs');
    expect(source).toContain('row.callTargets');
  });

  it('renders call-arrow disambiguation as colored source and target endpoints', () => {
    const source = arrowDisambigSource();
    expect(cssRule('.arrow-disambig-panel li.arrow-row .arrow-endpoint.source')).toContain(
      'color: #c2410c',
    );
    expect(cssRule('.arrow-disambig-panel li.arrow-row .arrow-endpoint.target')).toContain(
      'color: #2563eb',
    );
    expect(source).toContain('hit.arrow.toFieldName');
    expect(source).toContain('arrowDisambigGroupElement');
    expect(source).toContain('path-prefix');
  });

  it('renders a debug overlay for hovered field rows when debug mode is on', () => {
    // Hovering a field with debug enabled invokes the field variant of
    // the shared hover-debug panel; mouseleave hides via the same timer.
    const source = treeSource();
    expect(source).toContain('showFieldDebugPanel');
    expect(source).toMatch(/layoutDebugEnabled\(\)[\s\S]{0,200}?showFieldDebugPanel/);
    expect(source).toContain('field facts');
  });

  it('renders a debug overlay for hovered type headers when debug mode is on', () => {
    // The debug panel fires from FOUR header surfaces, so hovering
    // anywhere in the type header opens it: the dot, the label text,
    // and the two transparent hit rects (expand-hit + expand-arrow-hit).
    // Rect.expand-hit paints on top of the label under SVG's
    // visiblePainted rule, so without hover on the rects the label
    // handler never fires for areas not covered by glyphs.
    const source = treeSource();
    expect(source).toContain('showTypeDebugPanel');
    expect(source).toContain('type facts');
    // Static ownership counts (so the user can compare against routed
    // arrows to spot routing gaps) are part of the panel content.
    expect(source).toContain("'owners'");
    expect(source).toContain("'owns'");
    expect(source).toContain("Owners (analysis)");
    expect(source).toContain("Owns (analysis)");
    expect(source).toContain('headerDebugMouseenter');
    expect(source).toMatch(/rect\.expand-hit[\s\S]{0,800}?headerDebugMouseenter/);
    expect(source).toMatch(/rect\.expand-arrow-hit[\s\S]{0,500}?headerDebugMouseenter/);
    expect(source).toMatch(/text\.header-label[\s\S]{0,300}?showTypeDebugPanel/);
    expect(source).toMatch(/circle\.type-dot[\s\S]{0,1500}?showTypeDebugPanel/);
  });

  it('renders cross-crate arrows with a distinct dash pattern', () => {
    // Cross-crate arrows share color with intra-crate ones but get a
    // distinct dash so the boundary stands out. The dash pattern wins
    // over the per-kind rhythms.
    const source = treeSource();
    expect(source).toContain('CROSS_CRATE_DASH');
    expect(source).toMatch(/CROSS_CRATE_DASH\s*=\s*'6 2 1 2 1 2'/);
    expect(source).toMatch(/isCrossCrate === true.*CROSS_CRATE_DASH/);
  });

  it('colors signature rows by ownership flavor', () => {
    // Moves are the common case so they reuse the neutral grey
    // (COLOR_FIELD_TY) — no separate hex. Borrows are the interesting
    // non-default cases and get a hue shift each. If anyone deletes the
    // palette constants or the borrowFlavor wiring, the visual ownership
    // cue silently regresses.
    const source = treeSource();
    expect(source).toContain('COLOR_BORROW_MOVE = COLOR_FIELD_TY');
    expect(source).toContain("#c2410c"); // shared → orange-700
    expect(source).toContain("#7c3aed"); // mut → violet-600
    expect(source).toContain('borrowFlavor');
    expect(source).toContain('borrowFlavorColor');
  });
});
