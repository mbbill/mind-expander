// @vitest-environment jsdom
//
// GROUP D — Tier-1/Tier-2 jsdom coverage for the code panel's title-bar
// breadcrumb and its popup lifecycle. The whole cp-breadcrumb sub-area
// was jsdom-untested; the existing Tier-3 e2e (code-panel.spec.ts) only
// drives the folder→file happy path. These tests pin the binding +
// interaction contracts the catalog (PANEL-COVERAGE-GAPS.md "GROUP D")
// enumerates: plain-text fallback, button/separator structure, SHA
// filtering, popup positioning, expand/collapse recursion, dismissal +
// listener cleanup, the no-onShowFile show(1,1) fallback, and a batch of
// edge-case paths (single-file root, deep paths, escaping, unicode,
// folders-first sort).
//
// The panel is constructed via the real `createCodePanel` against a DOM
// root that mirrors index.html's `#code-panel`. fetch is stubbed so
// `show()` resolves synchronously-enough for assertions; for pure
// breadcrumb structure we drive `show()` and inspect the title without
// caring about the body fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFileTree, type FileTree } from '../../src/data/file_tree.ts';
import {
  createCodePanel,
  type CodePanel,
  type CodePanelOptions,
} from '../../src/view/code_panel.ts';

const ROOT = '/Users/me/ws';

// A small workspace tree:
//   ws/crateA/src/lib.rs
//   ws/crateA/src/widgets/gauge.rs
//   ws/crateA/src/widgets/meter.rs
//   ws/crateA/src/zeta.rs
const PATHS = [
  `${ROOT}/crateA/src/lib.rs`,
  `${ROOT}/crateA/src/widgets/gauge.rs`,
  `${ROOT}/crateA/src/widgets/meter.rs`,
  `${ROOT}/crateA/src/zeta.rs`,
];

function installCodePanelRoot(): void {
  document.body.innerHTML = `
    <aside id="code-panel" hidden>
      <div class="code-panel-header">
        <span class="code-panel-title">source</span>
        <button class="code-panel-close" type="button">×</button>
      </div>
      <pre class="code-panel-body"></pre>
      <div class="code-panel-resize code-panel-resize-l"></div>
    </aside>`;
}

function titleEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.code-panel-title');
  if (el === null) throw new Error('no title');
  return el;
}

function crumbs(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.code-panel-crumb')];
}

function popup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.code-panel-breadcrumb-popup');
}

function popupRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.code-panel-breadcrumb-popup-row')];
}

/** The visible label of a popup row (the row is [chevron-span,
 *  label-span]; the label is the last child). */
function labelOf(row: HTMLElement): string | null {
  return row.querySelector('span:last-child')?.textContent ?? null;
}

/** Stub fetch so `show()` always resolves with trivial source text. The
 *  breadcrumb is rendered synchronously by `show()` before the fetch
 *  resolves, so the body content is irrelevant for these tests. */
function stubFetch(text = 'fn main() {}\n'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ),
  );
}

function makePanel(over: Partial<CodePanelOptions> = {}): CodePanel {
  const opts: CodePanelOptions = {
    onLineNavigate: () => {},
    ...over,
  };
  return createCodePanel(opts);
}

beforeEach(() => {
  installCodePanelRoot();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('breadcrumb title — no fileTree (plain text fallback)', () => {
  it('renders the full path as plain text with a matching title attribute', () => {
    const panel = makePanel(); // no fileTree
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });

    const t = titleEl();
    // No breadcrumb buttons at all when fileTree is absent.
    expect(crumbs()).toHaveLength(0);
    // Title is the plain full path (a single text node).
    expect(t.textContent).toBe(`${ROOT}/crateA/src/widgets/gauge.rs`);
    // title attribute carries the same full path for hover/tooltip.
    expect(t.getAttribute('title')).toBe(`${ROOT}/crateA/src/widgets/gauge.rs`);
  });
});

describe('breadcrumb title — with fileTree', () => {
  let tree: FileTree;
  beforeEach(() => {
    tree = buildFileTree(PATHS);
  });

  it('renders one button per segment with a chevron separator between them', () => {
    const panel = makePanel({ fileTree: tree });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });

    // displayRoot collapses the common prefix `${ROOT}/crateA/src/`, so
    // the breadcrumb for widgets/gauge.rs is [widgets, gauge.rs].
    const segs = crumbs();
    expect(segs.map((b) => b.textContent)).toEqual(['widgets', 'gauge.rs']);

    // Each crumb is a real <button type="button">.
    for (const b of segs) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
    }

    // Separators: one chevron between each pair of segments.
    const seps = [...document.querySelectorAll('.code-panel-crumb-sep')];
    expect(seps).toHaveLength(segs.length - 1);
    expect(seps[0]?.textContent).toBe('›');

    // title attr is still the full path.
    expect(titleEl().getAttribute('title')).toBe(
      `${ROOT}/crateA/src/widgets/gauge.rs`,
    );
  });

  it('marks only the terminal file segment with is-file and leaves folders clickable', () => {
    const panel = makePanel({ fileTree: tree });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });

    const [widgets, gauge] = crumbs();
    expect(widgets?.classList.contains('is-file')).toBe(false);
    expect(gauge?.classList.contains('is-file')).toBe(true);

    // The file segment has no click handler: clicking it must not open a
    // popup. (Folder click is covered in the popup-lifecycle block.)
    gauge?.click();
    expect(popup()).toBeNull();
  });

  it('renders just the filename for a single-file-at-root path', () => {
    // A tree whose only file sits directly at the display root → the
    // breadcrumb is a single terminal file crumb, no separators.
    const single = buildFileTree([`${ROOT}/solo.rs`]);
    const panel = makePanel({ fileTree: single });
    panel.show({ file: `${ROOT}/solo.rs`, startLine: 1, endLine: 1 });

    const segs = crumbs();
    expect(segs.map((b) => b.textContent)).toEqual(['solo.rs']);
    expect(segs[0]?.classList.contains('is-file')).toBe(true);
    expect(document.querySelectorAll('.code-panel-crumb-sep')).toHaveLength(0);
  });

  it('renders every segment for a deep 5+ level path', () => {
    const deep = `${ROOT}/a/b/c/d/e/f.rs`;
    // A top-level sibling keeps the display root at `${ROOT}/` so all
    // intermediate directory segments survive (buildFileTree otherwise
    // collapses any directory levels shared by every indexed file).
    const deepTree = buildFileTree([deep, `${ROOT}/top.rs`]);
    const panel = makePanel({ fileTree: deepTree });
    panel.show({ file: deep, startLine: 1, endLine: 1 });

    expect(crumbs().map((b) => b.textContent)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f.rs',
    ]);
  });

  it('does not truncate very long segment names in the DOM', () => {
    const longName = 'a_very_long_module_name_that_should_not_be_truncated_in_the_dom';
    const longTree = buildFileTree([
      `${ROOT}/${longName}/x.rs`,
      `${ROOT}/top.rs`,
    ]);
    const panel = makePanel({ fileTree: longTree });
    panel.show({ file: `${ROOT}/${longName}/x.rs`, startLine: 1, endLine: 1 });

    const folderCrumb = crumbs().find((b) => !b.classList.contains('is-file'));
    expect(folderCrumb?.textContent).toBe(longName);
  });

  it('escapes special characters via textContent (no HTML injection)', () => {
    // A path segment containing angle brackets + ampersand must render
    // as literal text — textContent, never innerHTML.
    const weird = '<img src=x>&foo';
    const weirdTree = buildFileTree([
      `${ROOT}/${weird}/a.rs`,
      `${ROOT}/top.rs`,
    ]);
    const panel = makePanel({ fileTree: weirdTree });
    panel.show({ file: `${ROOT}/${weird}/a.rs`, startLine: 1, endLine: 1 });

    const folderCrumb = crumbs().find((b) => !b.classList.contains('is-file'));
    expect(folderCrumb?.textContent).toBe(weird);
    // No stray <img> element leaked into the DOM.
    expect(folderCrumb?.querySelector('img')).toBeNull();
  });

  it('renders unicode folder/file names verbatim', () => {
    const uni = 'café_模块';
    const uniTree = buildFileTree([
      `${ROOT}/${uni}/файл.rs`,
      `${ROOT}/top.rs`,
    ]);
    const panel = makePanel({ fileTree: uniTree });
    panel.show({ file: `${ROOT}/${uni}/файл.rs`, startLine: 1, endLine: 1 });

    expect(crumbs().map((b) => b.textContent)).toEqual([uni, 'файл.rs']);
  });
});

describe('breadcrumb SHA filtering (unified-diff mode)', () => {
  it('drops 40-char hex worktree-sha segments from the breadcrumb', () => {
    // In unified-diff mode the display root is the parent of the two
    // worktree-sha dirs, so the raw segments would start with a 40-hex
    // SHA. The panel filters those out so the breadcrumb starts at the
    // crate name.
    // Two worktree-sha dirs (base + head snapshots) share only the
    // `/tmp/me-diff/` parent, so each SHA survives as its own breadcrumb
    // segment — exactly the unified-diff layout the SHA filter targets.
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    const headFile = `/tmp/me-diff/${headSha}/crateA/src/widgets/gauge.rs`;
    const tree = buildFileTree([
      headFile,
      `/tmp/me-diff/${baseSha}/crateA/src/widgets/gauge.rs`,
    ]);
    const panel = makePanel({ fileTree: tree });
    panel.show({ file: headFile, startLine: 1, endLine: 1 });

    const texts = crumbs().map((b) => b.textContent);
    expect(texts).not.toContain(headSha);
    expect(texts).not.toContain(baseSha);
    // First visible segment is the crate name, not the SHA.
    expect(texts[0]).toBe('crateA');
    expect(texts).toEqual(['crateA', 'src', 'widgets', 'gauge.rs']);
  });
});

describe('breadcrumb popup — open / structure / folders-first', () => {
  let tree: FileTree;
  let panel: CodePanel;
  beforeEach(() => {
    tree = buildFileTree(PATHS);
    panel = makePanel({ fileTree: tree });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });
  });

  function openFolderPopup(text: string): void {
    const folder = crumbs().find((b) => b.textContent === text);
    if (folder === undefined) throw new Error(`no folder crumb ${text}`);
    folder.click();
  }

  it('opens a popup appended to document.body, positioned just below+left of the anchor', () => {
    const folder = crumbs().find((b) => !b.classList.contains('is-file'));
    if (folder === undefined) throw new Error('no folder');
    // Anchor rect is deterministic under jsdom only if we stub it.
    folder.getBoundingClientRect = () =>
      ({ left: 120, right: 180, top: 40, bottom: 58, width: 60, height: 18 }) as DOMRect;
    folder.click();

    const p = popup();
    expect(p).not.toBeNull();
    expect(p?.parentElement).toBe(document.body);
    // Left-aligns with the anchor's left; top is bottom + 2.
    expect(p?.style.left).toBe('120px');
    expect(p?.style.top).toBe('60px');
  });

  it('lists the clicked depth files alphabetically', () => {
    openFolderPopup('widgets');
    const rows = popupRows();
    // widgets/ has only files gauge.rs + meter.rs, sorted alphabetically.
    expect(rows.map((r) => labelOf(r))).toEqual(['gauge.rs', 'meter.rs']);
  });

  it('orders folders before files at a mixed level (buildFileTree sort)', () => {
    // `group/` mixes a folder (alpha) with files (beta.rs, zeta.rs). A
    // top-level sibling keeps the display root at `${ROOT}/` so `group`
    // survives as a clickable folder crumb.
    const nested = buildFileTree([
      `${ROOT}/top.rs`,
      `${ROOT}/proj/group/zeta.rs`,
      `${ROOT}/proj/group/alpha/a.rs`,
      `${ROOT}/proj/group/beta.rs`,
    ]);
    const p3 = makePanel({ fileTree: nested });
    p3.show({ file: `${ROOT}/proj/group/alpha/a.rs`, startLine: 1, endLine: 1 });
    // breadcrumb = [proj, group, alpha, a.rs]; click `group` → its
    // children are folder `alpha` + files `beta.rs`, `zeta.rs`.
    crumbs().find((b) => b.textContent === 'group')?.click();
    expect(popupRows().map((r) => labelOf(r))).toEqual([
      'alpha',
      'beta.rs',
      'zeta.rs',
    ]);
  });

  it('tags file rows with an is-file chevron carrying no glyph; folder rows carry "›"', () => {
    const nested = buildFileTree([
      `${ROOT}/top.rs`,
      `${ROOT}/proj/group/zeta.rs`,
      `${ROOT}/proj/group/alpha/a.rs`,
    ]);
    const p = makePanel({ fileTree: nested });
    p.show({ file: `${ROOT}/proj/group/alpha/a.rs`, startLine: 1, endLine: 1 });
    crumbs().find((b) => b.textContent === 'group')?.click();

    const rows = popupRows();
    const folderRow = rows.find((r) => labelOf(r) === 'alpha');
    const fileRow = rows.find((r) => labelOf(r) === 'zeta.rs');
    const folderChevron = folderRow?.querySelector('.code-panel-breadcrumb-popup-chevron');
    const fileChevron = fileRow?.querySelector('.code-panel-breadcrumb-popup-chevron');

    expect(folderChevron?.textContent).toBe('›');
    expect(folderChevron?.classList.contains('is-file')).toBe(false);
    expect(fileChevron?.classList.contains('is-file')).toBe(true);
    expect(fileChevron?.textContent).toBe('');
  });

  it('lists exactly the one child of a single-file folder (no empty message)', () => {
    // Every folder crumb has at least its descended child, so the
    // `(nothing indexed)` branch is defensive and unreachable through the
    // breadcrumb UI (buildFileTree never produces a childless directory
    // node). Pin the observable contract: a folder holding one file
    // renders exactly that row and no empty placeholder.
    const two = buildFileTree([
      `${ROOT}/proj/onlydir/only.rs`,
      `${ROOT}/proj/sibling.rs`,
    ]);
    const p2 = makePanel({ fileTree: two });
    p2.show({ file: `${ROOT}/proj/onlydir/only.rs`, startLine: 1, endLine: 1 });
    // breadcrumb = [proj, onlydir, only.rs]; clicking onlydir lists [only.rs].
    crumbs().find((b) => b.textContent === 'onlydir')?.click();
    expect(popupRows().map((r) => labelOf(r))).toEqual(['only.rs']);
    expect(popup()?.querySelector('.code-panel-breadcrumb-popup-empty')).toBeNull();
  });
});

describe('breadcrumb popup — expand / collapse recursion + padding', () => {
  it('expands a nested folder row in place, indenting children by depth*14+10px', () => {
    const nested = buildFileTree([
      `${ROOT}/top.rs`,
      `${ROOT}/proj/group/alpha/a.rs`,
      `${ROOT}/proj/group/alpha/b.rs`,
      `${ROOT}/proj/group/zeta.rs`,
    ]);
    const panel = makePanel({ fileTree: nested });
    panel.show({ file: `${ROOT}/proj/group/zeta.rs`, startLine: 1, endLine: 1 });
    // breadcrumb [proj, group, zeta.rs]; open `group`.
    crumbs().find((b) => b.textContent === 'group')?.click();

    const alphaRow = popupRows().find((r) => labelOf(r) === 'alpha');
    // Depth-0 rows get paddingLeft = 10 + 0*14 = 10px.
    expect(alphaRow?.style.paddingLeft).toBe('10px');
    // Collapsed folder: chevron lacks the `open` class.
    const chevron = alphaRow?.querySelector('.code-panel-breadcrumb-popup-chevron');
    expect(chevron?.classList.contains('open')).toBe(false);

    // Expand `alpha`.
    alphaRow?.click();
    const labels = popupRows().map((r) => labelOf(r));
    // alpha's children a.rs + b.rs now appear right after it.
    expect(labels).toContain('a.rs');
    expect(labels).toContain('b.rs');
    // Re-query alpha row: its chevron now has the `open` class.
    const alphaAfter = popupRows().find((r) => labelOf(r) === 'alpha');
    expect(
      alphaAfter
        ?.querySelector('.code-panel-breadcrumb-popup-chevron')
        ?.classList.contains('open'),
    ).toBe(true);
    // Child rows indent one level deeper: 10 + 1*14 = 24px.
    const childRow = popupRows().find((r) => labelOf(r) === 'a.rs');
    expect(childRow?.style.paddingLeft).toBe('24px');

    // Collapse again → children disappear, chevron loses `open`.
    alphaAfter?.click();
    expect(popupRows().map((r) => labelOf(r))).not.toContain('a.rs');
  });
});

describe('breadcrumb popup — file row activation', () => {
  it('fires onShowFile with the absolute path and closes the popup', () => {
    const onShowFile = vi.fn();
    const tree = buildFileTree(PATHS);
    const panel = makePanel({ fileTree: tree, onShowFile });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });
    crumbs().find((b) => b.textContent === 'widgets')?.click();

    const meterRow = popupRows().find(
      (r) => labelOf(r) === 'meter.rs',
    );
    meterRow?.click();

    expect(onShowFile).toHaveBeenCalledTimes(1);
    expect(onShowFile).toHaveBeenCalledWith(`${ROOT}/crateA/src/widgets/meter.rs`);
    // Popup is dismissed once a file is chosen.
    expect(popup()).toBeNull();
  });

  it('falls back to show()(startLine=endLine=1) when no onShowFile is wired', async () => {
    const tree = buildFileTree(PATHS);
    const fetchSpy = vi.fn(
      async (_input: string): Promise<Response> =>
        new Response('fn x() {}\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const panel = makePanel({ fileTree: tree }); // no onShowFile
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });
    fetchSpy.mockClear();

    crumbs().find((b) => b.textContent === 'widgets')?.click();
    const meterRow = popupRows().find(
      (r) => labelOf(r) === 'meter.rs',
    );
    meterRow?.click();

    // Popup closes immediately.
    expect(popup()).toBeNull();
    // Fallback path calls show() for the chosen file → /api/source fetch
    // for meter.rs.
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalled();
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toContain(encodeURIComponent(`${ROOT}/crateA/src/widgets/meter.rs`));
    // The title now reflects the newly shown file (show() re-rendered the
    // breadcrumb for meter.rs).
    expect(titleEl().getAttribute('title')).toBe(
      `${ROOT}/crateA/src/widgets/meter.rs`,
    );
  });

  it('stops file-row click propagation so it does not reach the document closer', () => {
    // The document-level mousedown closer would otherwise see the click
    // and could interfere; the row handler calls stopPropagation. We
    // assert the click event does not bubble past the popup to body.
    const onShowFile = vi.fn();
    const tree = buildFileTree(PATHS);
    const panel = makePanel({ fileTree: tree, onShowFile });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });
    crumbs().find((b) => b.textContent === 'widgets')?.click();

    const bodyClick = vi.fn();
    document.body.addEventListener('click', bodyClick);
    const fileRow = popupRows().find(
      (r) => labelOf(r) === 'gauge.rs',
    );
    fileRow?.click();
    document.body.removeEventListener('click', bodyClick);

    expect(bodyClick).not.toHaveBeenCalled();
  });
});

describe('breadcrumb popup — dismissal + listener lifecycle', () => {
  let tree: FileTree;
  let panel: CodePanel;
  beforeEach(() => {
    tree = buildFileTree(PATHS);
    panel = makePanel({ fileTree: tree });
    panel.show({ file: `${ROOT}/crateA/src/widgets/gauge.rs`, startLine: 1, endLine: 1 });
  });

  function openWidgetsPopup(): void {
    crumbs().find((b) => b.textContent === 'widgets')?.click();
  }

  it('closes on an outside mousedown (capture-phase document listener)', () => {
    openWidgetsPopup();
    expect(popup()).not.toBeNull();

    // mousedown outside the popup → closePopup.
    const outside = document.querySelector('.code-panel-body')!;
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popup()).toBeNull();
  });

  it('keeps the popup open on a mousedown inside it', () => {
    openWidgetsPopup();
    const p = popup();
    expect(p).not.toBeNull();

    p!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popup()).not.toBeNull();
  });

  it('closes on Escape via the capture-phase keydown listener', () => {
    openWidgetsPopup();
    expect(popup()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popup()).toBeNull();
  });

  it('ignores non-Escape keydowns', () => {
    openWidgetsPopup();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(popup()).not.toBeNull();
  });

  it('closes the previous popup before opening a new one (single popup invariant)', () => {
    // Open via the same folder twice; only one popup must ever exist.
    openWidgetsPopup();
    expect(document.querySelectorAll('.code-panel-breadcrumb-popup')).toHaveLength(1);
    openWidgetsPopup();
    expect(document.querySelectorAll('.code-panel-breadcrumb-popup')).toHaveLength(1);
  });

  it('removes its document listeners on close so stale events are inert after dismissal', () => {
    // closePopup() must unregister BOTH the capture-phase mousedown and
    // keydown listeners and null out popupEl. If a stale mousedown
    // listener leaked, it would still fire on later document clicks and
    // (because popupEl is null) be a no-op — but the real regression risk
    // is the OTHER direction: an old listener closing a freshly-opened
    // popup. We assert the observable invariant by interleaving
    // open→close→open and confirming exactly one popup survives and the
    // newest one responds to dismissal correctly.
    openWidgetsPopup();
    expect(document.querySelectorAll('.code-panel-breadcrumb-popup')).toHaveLength(1);

    // Close via Escape.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popup()).toBeNull();

    // A stray Escape after close must not throw and the DOM stays clean
    // (the keydown listener was removed; if it leaked it would still be a
    // safe no-op, but we also confirm no second popup was spawned).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.code-panel-breadcrumb-popup')).toHaveLength(0);

    // Re-open: exactly one popup, and it still dismisses on an outside
    // mousedown — proving the fresh listeners are wired and the old ones
    // didn't accumulate (a doubled mousedown handler would still close it,
    // but a doubled handler closing the NEW popup before this assertion
    // would have left zero popups after re-open, which we rule out here).
    openWidgetsPopup();
    expect(document.querySelectorAll('.code-panel-breadcrumb-popup')).toHaveLength(1);
    document
      .querySelector('.code-panel-body')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popup()).toBeNull();
  });

  it('closePopup() runs when show() re-renders the title (renderTitle closes any open popup)', () => {
    openWidgetsPopup();
    expect(popup()).not.toBeNull();
    // Showing a different file re-renders the breadcrumb → renderTitle
    // calls closePopup() at its start.
    panel.show({ file: `${ROOT}/crateA/src/zeta.rs`, startLine: 1, endLine: 1 });
    expect(popup()).toBeNull();
  });

  it('hide() closes any open popup', () => {
    openWidgetsPopup();
    expect(popup()).not.toBeNull();
    panel.hide();
    expect(popup()).toBeNull();
  });
});
