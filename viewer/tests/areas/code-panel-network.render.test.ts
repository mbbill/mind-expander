// @vitest-environment jsdom
//
// GROUP C — Tier-1/2 jsdom tests for the code panel's NETWORK / CACHE /
// FALLBACK layer in `view/code_panel.ts`. These exercise the observable
// behavior of `show()` / `refresh()` / `hide()` against a MOCKED global
// `fetch` (no server). The oracle for each test is the correct observable
// behavior derived from the real source, not a screenshot:
//
//   • /api/source status handling (200 renders; 404/500 → error div).
//   • loadFromBase → `&side=base` query param (and its absence by default).
//   • Source-mode same-file text cache: 2nd show() of the same file does
//     NOT refetch; refresh() busts that cache so it DOES refetch.
//   • Diff mode never uses the source cache (always refetches).
//   • Diff 204 (unchanged) and diff error (404/500) → source-mode fallback.
//   • renderDiff hunk-only fallback when the source fetch fails mid-diff.
//   • Loading-state placeholder visible while a fetch is inflight.
//   • Aborted fetch (hide() / rapid re-show()) does NOT mutate the DOM.
//
// Only synchronous DOM state and the mocked fetch's call record are
// asserted — deterministic, no wall-clock / randomness. The async load
// chain is flushed via microtask/macrotask ticks (matching
// diff-unified-mode.render.test.ts).

import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CodePanel, createCodePanel } from '../../src/view/code_panel.ts';

// ---------------------------------------------------------------------
// Scaffold + fetch helpers
// ---------------------------------------------------------------------

/** Build the `#code-panel` DOM scaffold `createCodePanel` requires. */
function mountPanelScaffold(): void {
  const root = document.createElement('div');
  root.id = 'code-panel';
  root.hidden = true;
  for (const cls of ['code-panel-header', 'code-panel-title', 'code-panel-resize-l']) {
    const el = document.createElement('div');
    el.className = cls;
    root.appendChild(el);
  }
  const close = document.createElement('button');
  close.className = 'code-panel-close';
  root.appendChild(close);
  const body = document.createElement('div');
  body.className = 'code-panel-body';
  root.appendChild(body);
  document.body.appendChild(root);
}

function bodyEl(): HTMLElement {
  return document.querySelector<HTMLElement>('.code-panel-body') as HTMLElement;
}

/** Flush the awaited load chain (fetchDiff → fetchSource → render). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const SOURCE_A = ['fn a() {}', 'fn b() {}', 'fn c() {}'].join('\n');
const SOURCE_BASE = ['fn removed() {}', 'fn gone() {}'].join('\n');

interface FetchCall {
  readonly url: string;
}

/** A response factory used by the source stub. */
function okText(text: string): Response {
  return { ok: true, status: 200, text: () => Promise.resolve(text) } as Response;
}
function errText(status: number, text = 'err'): Response {
  return { ok: false, status, text: () => Promise.resolve(text) } as Response;
}

/** Records every fetch URL so cache/refetch counts can be asserted. */
function recordedFetch(handler: (url: string) => Promise<Response>): {
  fn: Mock;
  calls: FetchCall[];
  sourceCount: () => number;
  diffCount: () => number;
} {
  const calls: FetchCall[] = [];
  const fn = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push({ url });
    return handler(url);
  });
  vi.stubGlobal('fetch', fn);
  return {
    fn,
    calls,
    sourceCount: () => calls.filter((c) => c.url.startsWith('/api/source')).length,
    diffCount: () => calls.filter((c) => c.url.startsWith('/api/diff')).length,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  mountPanelScaffold();
});

// ---------------------------------------------------------------------
// /api/source status handling: 200 / 404 / 500
// ---------------------------------------------------------------------

describe('source mode — /api/source status handling', () => {
  it('200 renders one .code-panel-line per source line, no error div', async () => {
    recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    const body = bodyEl();
    expect(body.querySelectorAll('.code-panel-line').length).toBe(3);
    expect(body.querySelector('.code-panel-error')).toBeNull();
    expect(body.querySelector('.code-panel-loading')).toBeNull();
  });

  it('404 renders an error message carrying the HTTP status, no source lines', async () => {
    recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(errText(404, 'not found'))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/missing.rs', startLine: 1, endLine: 1 });
    await settle();
    const body = bodyEl();
    const err = body.querySelector<HTMLElement>('.code-panel-error');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('src/missing.rs');
    expect(err?.textContent).toContain('404');
    expect(body.querySelectorAll('.code-panel-line').length).toBe(0);
  });

  it('500 renders an error message carrying the HTTP status', async () => {
    recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(errText(500, 'boom'))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/broken.rs', startLine: 1, endLine: 1 });
    await settle();
    const err = bodyEl().querySelector<HTMLElement>('.code-panel-error');
    expect(err?.textContent).toContain('500');
  });
});

// ---------------------------------------------------------------------
// side=base param: loadFromBase routing
// ---------------------------------------------------------------------

describe('source mode — side=base query param', () => {
  it('loadFromBase=true fetches /api/source with &side=base', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_BASE))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/deleted.rs', startLine: 1, endLine: 1, loadFromBase: true });
    await settle();
    const sourceCall = r.calls.find((c) => c.url.startsWith('/api/source'));
    expect(sourceCall?.url).toContain('side=base');
    // The base snapshot bytes were rendered.
    expect(bodyEl().querySelectorAll('.code-panel-line').length).toBe(2);
  });

  it('loadFromBase=false (default) omits the side param entirely', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    const sourceCall = r.calls.find((c) => c.url.startsWith('/api/source'));
    expect(sourceCall?.url).not.toContain('side=');
  });
});

// ---------------------------------------------------------------------
// Source-mode same-file text cache + refresh() cache-busting
// ---------------------------------------------------------------------

describe('source mode — same-file text cache fast-path', () => {
  it('a 2nd show() of the SAME file re-renders from cache (no 2nd fetch)', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(r.sourceCount()).toBe(1);

    // Same file, different span — should hit the cache fast-path.
    panel.show({ file: 'src/a.rs', startLine: 2, endLine: 2 });
    await settle();
    expect(r.sourceCount()).toBe(1);
    // The new span is reflected without a refetch.
    const rows = bodyEl().querySelectorAll<HTMLElement>('.code-panel-line.entity-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.dataset.line).toBe('2');
  });

  it('show() of a DIFFERENT file refetches (cache is keyed by file)', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    panel.show({ file: 'src/b.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(r.sourceCount()).toBe(2);
  });

  it('refresh(args) busts the cache and refetches at the new span', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(r.sourceCount()).toBe(1);

    // Live-reload re-resolve: same file, new span. Must refetch (the
    // on-disk bytes may have changed) even though the file matches.
    panel.refresh({ file: 'src/a.rs', startLine: 3, endLine: 3 });
    await settle();
    expect(r.sourceCount()).toBe(2);
    const rows = bodyEl().querySelectorAll<HTMLElement>('.code-panel-line.entity-row');
    expect(rows[0]?.dataset.line).toBe('3');
  });

  it('refresh() without args busts the cache and re-fetches the current file', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(r.sourceCount()).toBe(1);

    panel.refresh();
    await settle();
    expect(r.sourceCount()).toBe(2);
  });

  it('refresh() is a no-op (no fetch) when the panel is closed', async () => {
    const r = recordedFetch((url) =>
      url.startsWith('/api/source')
        ? Promise.resolve(okText(SOURCE_A))
        : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    panel.hide();
    const before = r.sourceCount();
    panel.refresh();
    await settle();
    expect(r.sourceCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------
// Diff mode — always refetches; never uses the source cache
// ---------------------------------------------------------------------

const DIFF_PAYLOAD = {
  file_old: 'src/a.rs',
  file_new: 'src/a.rs',
  hunks: [
    {
      old_start: 1,
      old_count: 1,
      new_start: 1,
      new_count: 1,
      lines: [{ kind: 'add', text: 'fn added() {}', new: 1 }],
    },
  ],
};

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as Response;
}

describe('diff mode — refetch behavior', () => {
  it('showing the same diff file twice issues a fresh /api/diff each time', async () => {
    const r = recordedFetch((url) => {
      if (url.startsWith('/api/diff')) return Promise.resolve(okJson(DIFF_PAYLOAD));
      if (url.startsWith('/api/source')) return Promise.resolve(okText(SOURCE_A));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(r.diffCount()).toBe(1);

    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    // Diff mode skips the source-text cache: a 2nd show() must refetch.
    expect(r.diffCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Diff fallback to source mode: 204 (unchanged) and error (404/500)
// ---------------------------------------------------------------------

describe('diff mode — fallback to source', () => {
  it('diff 204 (unchanged) falls back to source mode and renders source lines', async () => {
    const r = recordedFetch((url) => {
      if (url.startsWith('/api/diff')) {
        return Promise.resolve({ ok: false, status: 204 } as Response);
      }
      if (url.startsWith('/api/source')) return Promise.resolve(okText(SOURCE_A));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    const body = bodyEl();
    // Source-mode render: plain rows carry data-line, NOT data-kind.
    expect(body.querySelectorAll('.code-panel-line').length).toBe(3);
    expect(body.querySelector('.code-panel-line[data-kind]')).toBeNull();
    expect(body.querySelector('.code-panel-line[data-line]')).not.toBeNull();
    expect(r.diffCount()).toBe(1);
    expect(r.sourceCount()).toBe(1);
  });

  it('diff 500 error falls back to source mode (no side param)', async () => {
    const r = recordedFetch((url) => {
      if (url.startsWith('/api/diff')) return Promise.resolve(errText(500));
      if (url.startsWith('/api/source')) return Promise.resolve(okText(SOURCE_A));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(bodyEl().querySelector('.code-panel-line[data-kind]')).toBeNull();
    expect(bodyEl().querySelectorAll('.code-panel-line').length).toBe(3);
    const sourceCall = r.calls.find((c) => c.url.startsWith('/api/source'));
    expect(sourceCall?.url).not.toContain('side=');
  });

  it('diff 404 error falls back to source mode', async () => {
    recordedFetch((url) => {
      if (url.startsWith('/api/diff')) return Promise.resolve(errText(404));
      if (url.startsWith('/api/source')) return Promise.resolve(okText(SOURCE_A));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    expect(bodyEl().querySelectorAll('.code-panel-line').length).toBe(3);
    expect(bodyEl().querySelector('.code-panel-line[data-kind]')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// renderDiff hunk-only fallback when the in-diff source fetch fails
// ---------------------------------------------------------------------

describe('diff mode — hunk-only fallback when source fetch fails', () => {
  it('renders ONLY hunk lines (no inline context) when /api/source errors', async () => {
    recordedFetch((url) => {
      if (url.startsWith('/api/diff')) return Promise.resolve(okJson(DIFF_PAYLOAD));
      if (url.startsWith('/api/source')) return Promise.resolve(errText(500));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await settle();
    const body = bodyEl();
    // The single hunk's add line renders; with sourceLines=null no
    // trailing/inline context rows are emitted, so only hunk rows exist.
    const lines = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line'));
    expect(lines.length).toBe(1);
    expect(lines[0]?.dataset.kind).toBe('add');
    // Not the error state — the diff itself rendered fine.
    expect(body.querySelector('.code-panel-error')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Loading state during a slow fetch
// ---------------------------------------------------------------------

describe('loading state', () => {
  it('shows the "Loading…" placeholder while the source fetch is inflight', async () => {
    let resolveSource!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveSource = res;
    });
    recordedFetch((url) =>
      url.startsWith('/api/source') ? pending : Promise.reject(new Error(`unexpected ${url}`)),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    // Fetch has not resolved yet: the loading placeholder is on screen.
    await Promise.resolve();
    const loading = bodyEl().querySelector<HTMLElement>('.code-panel-loading');
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain('Loading');
    expect(bodyEl().querySelector('.code-panel-line')).toBeNull();

    // Resolve and confirm the placeholder is replaced by the source.
    resolveSource(okText(SOURCE_A));
    await settle();
    expect(bodyEl().querySelector('.code-panel-loading')).toBeNull();
    expect(bodyEl().querySelectorAll('.code-panel-line').length).toBe(3);
  });
});

// ---------------------------------------------------------------------
// Abort: hide() and rapid re-show() must not mutate the DOM with a
// stale (aborted) response.
// ---------------------------------------------------------------------

describe('abort handling', () => {
  it('hide() aborts the inflight fetch; a late resolution does not render', async () => {
    let resolveSource!: (r: Response) => void;
    let capturedSignal: AbortSignal | undefined;
    const pending = new Promise<Response>((res) => {
      resolveSource = res;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void input;
        capturedSignal = init?.signal ?? undefined;
        return pending;
      }),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/a.rs', startLine: 1, endLine: 1 });
    await Promise.resolve();
    expect(bodyEl().querySelector('.code-panel-loading')).not.toBeNull();

    // hide() aborts the controller and closes the panel.
    panel.hide();
    expect(capturedSignal?.aborted).toBe(true);
    expect(panel.isOpen()).toBe(false);

    // The fetch resolves AFTER abort — the signal.aborted guard must
    // prevent any DOM mutation (no source lines appear).
    resolveSource(okText(SOURCE_A));
    await settle();
    expect(bodyEl().querySelector('.code-panel-line')).toBeNull();
  });

  it('rapid re-show() aborts the first request; only the latest render wins', async () => {
    const deferreds: Array<{
      url: string;
      resolve: (r: Response) => void;
      signal: AbortSignal | undefined;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        return new Promise<Response>((resolve) => {
          deferreds.push({ url, resolve, signal: init?.signal ?? undefined });
        });
      }),
    );
    const panel = createCodePanel({ onLineNavigate: () => {} });
    panel.show({ file: 'src/first.rs', startLine: 1, endLine: 1 });
    await Promise.resolve();
    panel.show({ file: 'src/second.rs', startLine: 1, endLine: 1 });
    await Promise.resolve();

    // The first fetch's signal is aborted by the 2nd show().
    expect(deferreds[0]?.signal?.aborted).toBe(true);
    expect(deferreds[1]?.signal?.aborted).toBe(false);

    // Resolve the STALE first request last; its aborted guard must skip
    // the render. Then resolve the live one and confirm it wins.
    deferreds[0]?.resolve(okText('fn stale() {}'));
    deferreds[1]?.resolve(okText(SOURCE_A));
    await settle();
    expect(bodyEl().querySelectorAll('.code-panel-line').length).toBe(3);
  });
});
