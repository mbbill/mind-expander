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
    expect(source).toContain('isCallable && layoutDebugEnabled()');
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
});
