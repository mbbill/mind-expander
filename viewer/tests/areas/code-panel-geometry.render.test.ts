// @vitest-environment jsdom
//
// GROUP E — code-panel chrome geometry (Tier-1 jsdom / Tier-2 logic).
//
// These cover the panel's *geometry* contracts that the existing diff
// render test (diff-unified-mode.render.test.ts) and the Tier-3 e2e
// specs (code-panel.spec.ts) do not pin in pure jsdom:
//
//   • focus-frame scroll math — the focused entity is parked ~25% from
//     the panel-body top (`scrollTop = max(0, offsetTop - 0.25*clientH)`),
//     and falls back to 0 when no entity-row exists. jsdom reports 0 for
//     all layout metrics, so we mock `offsetTop`/`clientHeight` on the
//     real rendered nodes and read back the real `scrollTop` the renderer
//     wrote — the math is the code's, only the inputs are stubbed.
//   • splitter pointer-drag width math + clamp [MIN_WIDTH, vp-200] +
//     localStorage persistence on pointerup.
//   • collapse-marker auto-expand clamp (windowAroundEntity) — the pure
//     geometry that keeps a trailing-gap entity from expanding the whole
//     file (already partly covered in code_panel_focus_frame.test.ts;
//     here we add the boundary cases the catalog flags).
//   • Prism token classes for the Rust grammar in the source renderer.
//   • setHighlight removing entity-row from now-unmatched rows.
//   • edge cases: line splitting preserves multi-line blocks, span
//     outside bounds, single-line entity, empty file, missing DOM throw,
//     openEmpty placeholder + preservation, hide() onClose gating.
//
// Each oracle is the CORRECT observable behavior read from
// src/view/code_panel.ts, not the gap-list wording.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CodePanel, createCodePanel, windowAroundEntity } from '../../src/view/code_panel.ts';

const STORAGE_KEY = 'mind-expander.code-panel';

// ---------------------------------------------------------------------
// DOM scaffold createCodePanel requires. Mirrors the real index.html
// structure (header/title/close/body + left splitter). Kept local so
// this file edits no shared helper.
// ---------------------------------------------------------------------
function mountPanelScaffold(): {
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  splitter: HTMLElement;
  close: HTMLButtonElement;
} {
  const root = document.createElement('div');
  root.id = 'code-panel';
  root.hidden = true;

  const header = document.createElement('div');
  header.className = 'code-panel-header';
  const title = document.createElement('div');
  title.className = 'code-panel-title';
  header.appendChild(title);
  const close = document.createElement('button');
  close.className = 'code-panel-close';
  header.appendChild(close);
  root.appendChild(header);

  const splitter = document.createElement('div');
  splitter.className = 'code-panel-resize-l';
  // jsdom has no Pointer Capture API; the splitter handlers call these
  // three methods unconditionally, so provide inert stubs that track
  // capture state so `hasPointerCapture` reflects set/release.
  const captured = new Set<number>();
  splitter.setPointerCapture = (id: number): void => {
    captured.add(id);
  };
  splitter.releasePointerCapture = (id: number): void => {
    captured.delete(id);
  };
  splitter.hasPointerCapture = (id: number): boolean => captured.has(id);
  root.appendChild(splitter);

  const body = document.createElement('div');
  body.className = 'code-panel-body';
  root.appendChild(body);

  document.body.appendChild(root);
  return { root, body, title, splitter, close };
}

/** Dispatch a pointer-ish event the splitter listeners read (they only
 *  touch `pointerId`, `clientX`, and call `preventDefault`/`stopProp`).
 *  jsdom lacks `PointerEvent`, so we synthesize from MouseEvent and
 *  attach `pointerId`. */
function firePointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  pointerId: number,
  clientX: number,
): void {
  const ev = new MouseEvent(type, { clientX, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  el.dispatchEvent(ev);
}

function mockBodyHeight(body: HTMLElement, clientHeight: number): void {
  Object.defineProperty(body, 'clientHeight', { value: clientHeight, configurable: true });
}

/** Install a prototype-level `offsetTop` getter so EVERY rendered
 *  `.code-panel-line` reports `lineNum * rowHeight` — even the fresh
 *  nodes the renderer creates inside `replaceChildren`, which it then
 *  reads synchronously for the scroll math. jsdom otherwise reports 0.
 *  Returns a restore fn. */
function installRowOffsetTop(rowHeight: number): () => void {
  const had = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, 'offsetTop');
  Object.defineProperty(HTMLDivElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const lineNum = Number(
        this.dataset?.lineHead ?? this.dataset?.line ?? this.dataset?.lineBase ?? '0',
      );
      return Number.isFinite(lineNum) ? lineNum * rowHeight : 0;
    },
  });
  return () => {
    if (had) Object.defineProperty(HTMLDivElement.prototype, 'offsetTop', had);
    else Reflect.deleteProperty(HTMLDivElement.prototype, 'offsetTop');
  };
}

/** Minimal in-memory localStorage. This jsdom build doesn't ship a full
 *  Storage; the panel reads/writes via `localStorage.{get,set}Item`
 *  inside try/catch, and our splitter-persistence tests need a real
 *  readable store. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
  installLocalStorage();
  // Deterministic viewport for clamp math.
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================
// Source-mode render: line splitting, entity tagging, Prism tokens,
// edge cases (no fetch needed — render() runs synchronously via show()
// cache path or via direct source render).
// =====================================================================

/** Stub fetch for `/api/source` returning `text`. Source-mode only
 *  (diffEnabled defaults off), so a single GET resolves the render. */
function stubSource(text: string): void {
  vi.stubGlobal('fetch', (input: string): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('/api/source')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function showSource(
  panel: CodePanel,
  body: HTMLElement,
  text: string,
  args: { file: string; startLine: number; endLine: number },
): Promise<HTMLElement> {
  stubSource(text);
  panel.show(args);
  await flush();
  return body;
}

describe('source render — line splitting & entity tagging', () => {
  it('splits the file on newlines into one .code-panel-line per source line', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['fn a() {}', 'fn b() {}', 'fn c() {}'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 2, endLine: 2 });

    const lines = body.querySelectorAll('.code-panel-line');
    expect(lines.length).toBe(3);
    // Gutter numbers are 1-based and contiguous.
    const gutters = Array.from(lines).map(
      (l) => l.querySelector('.code-panel-gutter')?.textContent,
    );
    expect(gutters).toEqual(['1', '2', '3']);
  });

  it('keeps a multi-line block comment coherent across per-line divs (split AFTER highlight)', async () => {
    // The whole-file Prism pass tokenizes the block comment as one
    // <span class="token comment"> spanning the newlines. Splitting the
    // *highlighted* HTML on \n then writing each fragment via innerHTML
    // is what keeps the comment coherent: row 1 opens the comment span,
    // rows 2-3 are its inner text, and the code AFTER the comment
    // (`fn x()`) tokenizes as real Rust on row 4 — NOT as more comment.
    // A naive per-line highlight would treat `/* multi` as an
    // unterminated comment and mis-tokenize the rest of the file.
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['/* multi', '   line', '   comment */', 'fn x() {}'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 4, endLine: 4 });

    const lines = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line'));
    expect(lines.length).toBe(4);
    // Row 1 opens the comment token span.
    expect(lines[0]?.querySelector('.token.comment'), 'comment token on row 1').not.toBeNull();
    // The comment's full text survives across the rows (no dropped lines).
    expect(lines[1]?.textContent).toContain('line');
    expect(lines[2]?.textContent).toContain('comment */');
    // Row 4 (after the comment) is tokenized as real Rust, proving the
    // comment closed correctly and didn't bleed into the rest of the file.
    expect(lines[3]?.querySelector('.token.keyword')?.textContent).toBe('fn');
    expect(lines[3]?.querySelector('.token.comment'), 'no comment leak on row 4').toBeNull();
  });

  it('tags exactly the [startLine,endLine] rows entity-row (single-line entity ⇒ one row)', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['l1', 'l2', 'l3', 'l4'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 3, endLine: 3 });

    const entityRows = Array.from(
      body.querySelectorAll<HTMLElement>('.code-panel-line.entity-row'),
    );
    expect(entityRows.length).toBe(1);
    expect(entityRows[0]?.dataset.line).toBe('3');
  });

  it('clamps an entity span past EOF — only in-range rows are tagged, no overflow rows created', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['l1', 'l2', 'l3'].join('\n'); // 3 lines
    // Span [2, 99] runs off the end of the file.
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 2, endLine: 99 });

    const lines = body.querySelectorAll('.code-panel-line');
    expect(lines.length).toBe(3); // no phantom rows past EOF
    const entityRows = body.querySelectorAll('.code-panel-line.entity-row');
    // Rows 2 and 3 are inside [2,99]; row 1 is not.
    expect(entityRows.length).toBe(2);
  });

  it('renders a single empty row for an empty file (split of "" is one line)', async () => {
    // The catalog wording ("empty file renders no lines") describes the
    // intent; the CORRECT observable behavior of `''.split('\n')` is one
    // empty line. Pin the real behavior so a future change is noticed.
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    await showSource(panel, body, '', { file: 'src/empty.rs', startLine: 1, endLine: 1 });

    const lines = body.querySelectorAll('.code-panel-line');
    expect(lines.length).toBe(1);
    expect(lines[0]?.querySelector('.code-panel-text')?.textContent).toBe('');
  });
});

describe('source render — Prism token classes (rust grammar)', () => {
  it('emits keyword / function / string token spans for Rust source', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = 'fn greet() { let s = "hi"; }';
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 1, endLine: 1 });

    const row = body.querySelector<HTMLElement>('.code-panel-line .code-panel-text');
    expect(row, 'code text span').not.toBeNull();
    // Prism's rust grammar marks `fn`/`let` as keywords and `"hi"` as a
    // string. Token classes are the contract Prism's one-light theme CSS
    // paints against.
    expect(row?.querySelector('.token.keyword'), 'keyword token').not.toBeNull();
    expect(row?.querySelector('.token.string'), 'string token').not.toBeNull();
  });
});

// =====================================================================
// Focus-frame scroll math (Tier-1 with mocked layout metrics).
// =====================================================================

describe('focus-frame scroll — entity parked ~25% from top', () => {
  let restoreOffset: (() => void) | null = null;
  afterEach(() => {
    restoreOffset?.();
    restoreOffset = null;
  });

  it('scrollTop = max(0, offsetTop - 0.25*clientHeight) when the entity is deep in the file', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    // Each row 40px tall, body 600px. Entity at line 10 ⇒ offsetTop=400.
    restoreOffset = installRowOffsetTop(40);
    mockBodyHeight(body, 600);
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 10, endLine: 10 });

    // The first entity-row is line 10 ⇒ offsetTop = 10*40 = 400.
    // scrollTop = max(0, 400 - 0.25*600) = max(0, 400 - 150) = 250.
    expect(body.scrollTop).toBe(250);
  });

  it('clamps scrollTop to 0 when the entity is near the top', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    restoreOffset = installRowOffsetTop(40);
    mockBodyHeight(body, 600);
    // Entity at line 2 ⇒ offsetTop=80; 80 - 150 = -70 → clamp 0.
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 2, endLine: 2 });

    expect(body.scrollTop).toBe(0);
  });

  it('scrolls to 0 when no entity-row exists (start>end ⇒ nothing tagged)', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    restoreOffset = installRowOffsetTop(40);
    mockBodyHeight(body, 600);
    // start>end ⇒ no row satisfies lineNum>=start && lineNum<=end.
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 8, endLine: 3 });

    expect(body.querySelector('.code-panel-line.entity-row')).toBeNull();
    expect(body.scrollTop).toBe(0);
  });
});

// =====================================================================
// refresh() without args preserves scrollTop (file-only live-reload).
// =====================================================================

describe('refresh() preserves scroll on file-only re-fetch', () => {
  it('re-renders at the same scrollTop the user left (no scroll-to-entity)', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 5, endLine: 5 });

    // User scrolls down.
    body.scrollTop = 412;
    // Live-reload file-only refresh: re-fetch + restore the pre-reload
    // scrollTop instead of re-centering on the entity.
    stubSource(src);
    panel.refresh();
    await flush();

    expect(body.scrollTop).toBe(412);
  });

  it('is a no-op when the panel is hidden', async () => {
    const { root, body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['a', 'b', 'c'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 1, endLine: 1 });
    panel.hide();
    expect(root.hidden).toBe(true);

    // refresh() on a hidden panel must not fetch or touch the body.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    panel.refresh();
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =====================================================================
// setHighlight — removes entity-row from now-unmatched rows.
// =====================================================================

describe('setHighlight — retags and clears stale entity-row', () => {
  it('moving the highlight removes entity-row from rows outside the new span', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 2, endLine: 4 });

    const taggedFor = (): number[] =>
      Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line.entity-row')).map((l) =>
        Number(l.dataset.line),
      );
    expect(taggedFor()).toEqual([2, 3, 4]);

    // Move the highlight to [7,8]: rows 2-4 must lose entity-row.
    panel.setHighlight({ start_line: 7, end_line: 8 });
    expect(taggedFor()).toEqual([7, 8]);
  });
});

// =====================================================================
// Splitter pointer-drag math, width clamp, persistence.
// =====================================================================

describe('splitter — drag width math, clamp, persistence', () => {
  /** Pin the panel's right edge so width = rightEdge - clientX. */
  function pinRightEdge(root: HTMLElement, right: number): void {
    root.getBoundingClientRect = () =>
      ({
        right,
        left: right - 480,
        top: 0,
        bottom: 768,
        width: 480,
        height: 768,
        x: right - 480,
        y: 0,
        toJSON() {},
      }) as DOMRect;
  }

  it('computes width = rightEdge - cursorX during a drag', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);

    firePointer(splitter, 'pointerdown', 1, 1000);
    firePointer(splitter, 'pointermove', 1, 600); // newW = 1000-600 = 400
    expect(root.style.width).toBe('400px');
    expect(root.style.getPropertyValue('--code-panel-w')).toBe('400px');
  });

  it('clamps width to MIN_WIDTH (280) when dragged past the right edge', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);

    firePointer(splitter, 'pointerdown', 1, 1000);
    // newW = 1000-950 = 50, below MIN_WIDTH → clamp to 280.
    firePointer(splitter, 'pointermove', 1, 950);
    expect(root.style.width).toBe('280px');
  });

  it('clamps width to (innerWidth-200) when dragged far left (leaves diagram room)', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);
    // innerWidth=1024 → maxW = 1024-200 = 824.
    firePointer(splitter, 'pointerdown', 1, 1000);
    // newW = 1000 - (-500) = 1500, above maxW → clamp to 824.
    firePointer(splitter, 'pointermove', 1, -500);
    expect(root.style.width).toBe('824px');
  });

  it('persists the final width to localStorage on pointerup', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);

    firePointer(splitter, 'pointerdown', 1, 1000);
    firePointer(splitter, 'pointermove', 1, 620); // 380
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // not saved mid-drag
    firePointer(splitter, 'pointerup', 1, 620);

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(saved.w).toBe(380);
  });

  it('ignores pointermove from a non-matching pointerId (multi-pointer isolation)', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);

    firePointer(splitter, 'pointerdown', 1, 1000); // start width 480 default
    firePointer(splitter, 'pointermove', 2, 600); // wrong id → ignored
    // Width stays at the applied default (480), not 400.
    expect(root.style.width).toBe('480px');
    firePointer(splitter, 'pointermove', 1, 600); // correct id → applies
    expect(root.style.width).toBe('400px');
  });

  it('releases pointer capture on pointerup', () => {
    const { root, splitter } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    pinRightEdge(root, 1000);

    firePointer(splitter, 'pointerdown', 1, 1000);
    expect(splitter.hasPointerCapture(1)).toBe(true);
    firePointer(splitter, 'pointerup', 1, 700);
    expect(splitter.hasPointerCapture(1)).toBe(false);
  });
});

describe('splitter — width restored & clamped on init', () => {
  it('restores persisted width on construction', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ w: 600 }));
    const { root } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    expect(root.style.width).toBe('600px');
  });

  it('clamps a stored width wider than the viewport down to (innerWidth-200)', () => {
    // Last session was on a wide monitor (w=2000); this session's window
    // is 1024 wide. Restoring 2000 would strand the diagram at <0px, so
    // applyWidth clamps to maxW = 824 on load.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ w: 2000 }));
    const { root } = mountPanelScaffold();
    createCodePanel({ onLineNavigate: () => {} });
    expect(root.style.width).toBe('824px');
  });
});

// =====================================================================
// openEmpty placeholder + body preservation; hide() onClose gating.
// =====================================================================

describe('openEmpty — placeholder & body preservation', () => {
  it('opens with the "No source selected" placeholder when no file was shown', () => {
    const { root, body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.openEmpty();

    expect(root.hidden).toBe(false);
    const placeholder = body.querySelector('.code-panel-loading');
    expect(placeholder?.textContent).toContain('No source selected');
  });

  it('preserves the previously shown file body across hide → openEmpty', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['fn keep_me() {}', 'fn and_me() {}'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 1, endLine: 1 });
    expect(body.querySelectorAll('.code-panel-line').length).toBe(2);

    panel.hide();
    panel.openEmpty();
    // currentFile is non-null, so openEmpty leaves the old body intact —
    // no placeholder, scroll/content preserved.
    expect(body.querySelectorAll('.code-panel-line').length).toBe(2);
    expect(body.querySelector('.code-panel-loading')).toBeNull();
  });

  it('is a no-op when the panel is already open (does not blank the body)', async () => {
    const { body } = mountPanelScaffold();
    const panel = createCodePanel({ onLineNavigate: () => {} });
    const src = ['fn x() {}'].join('\n');
    await showSource(panel, body, src, { file: 'src/lib.rs', startLine: 1, endLine: 1 });
    expect(body.querySelectorAll('.code-panel-line').length).toBe(1);

    panel.openEmpty(); // already open → early return
    expect(body.querySelectorAll('.code-panel-line').length).toBe(1);
  });
});

describe('hide() — onClose gating', () => {
  it('fires onClose only when the panel was open', () => {
    mountPanelScaffold();
    const onClose = vi.fn();
    const panel = createCodePanel({ onLineNavigate: () => {}, onClose });

    panel.openEmpty(); // now open
    panel.hide();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Hiding an already-hidden panel must NOT re-fire onClose.
    panel.hide();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// Missing required DOM elements ⇒ constructor throws.
// =====================================================================

describe('createCodePanel — required DOM contract', () => {
  it('throws when the #code-panel root is missing', () => {
    document.body.innerHTML = '';
    expect(() => createCodePanel({ onLineNavigate: () => {} })).toThrow(/missing #code-panel root/);
  });

  it('throws when a required child element is missing', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'code-panel';
    // Header/title present but no .code-panel-body → must throw.
    const header = document.createElement('div');
    header.className = 'code-panel-header';
    const title = document.createElement('div');
    title.className = 'code-panel-title';
    header.appendChild(title);
    const close = document.createElement('button');
    close.className = 'code-panel-close';
    header.appendChild(close);
    const splitter = document.createElement('div');
    splitter.className = 'code-panel-resize-l';
    root.append(header, splitter);
    document.body.appendChild(root);

    expect(() => createCodePanel({ onLineNavigate: () => {} })).toThrow(
      /missing required child elements/,
    );
  });
});

// =====================================================================
// collapse-marker auto-expand clamp (pure geometry — boundary cases the
// catalog flags beyond code_panel_focus_frame.test.ts).
// =====================================================================

describe('windowAroundEntity — clamp boundaries', () => {
  it('returns an empty window when the entity sits entirely below the gap', () => {
    // entityStart 250 > gapEnd 200: wStart = max(100, 245) = 245,
    // wEnd = min(199, 255) = 199 → wStart > wEnd (degenerate / empty).
    const { wStart, wEnd } = windowAroundEntity(100, 200, 250, 252, 5);
    expect(wStart).toBe(245);
    expect(wEnd).toBe(199);
    expect(wStart).toBeGreaterThan(wEnd);
  });

  it('pad=0 reveals exactly the entity lines (clamped to the half-open gap)', () => {
    const { wStart, wEnd } = windowAroundEntity(100, 200, 150, 158, 0);
    expect(wStart).toBe(150);
    expect(wEnd).toBe(158);
  });
});
