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

describe('selected arrow styling', () => {
  it('does not change arrow stroke width on selection', () => {
    expect(cssRule('#tree g.arrows path.visible.highlighted')).not.toContain('stroke-width');
    expect(cssRule('#tree g.arrows path.visible.method.highlighted')).not.toContain('stroke-width');
  });

  it('keeps idle canonical ownership arrows shallower than selected arrows', () => {
    expect(
      cssRule(
        '#tree g.arrows path.visible.canonical:not(.method):not(.reexport):not(.highlighted)',
      ),
    ).toContain('opacity: 0.45');
    expect(cssRule('#tree g.arrows path.visible.highlighted')).toContain('opacity: 1');
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
});
