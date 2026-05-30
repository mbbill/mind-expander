// @vitest-environment jsdom
//
// Tier-1 DOM-binding tests for the code-panel CLICK → coordinate-key
// derivation (GROUP A: deletion-bearing diff click correctness).
//
// The renderer side of the diff (data-kind tinting, gutters, the union
// focus frame) is covered in diff-unified-mode.render.test.ts. This file
// covers the OTHER half that powers the click-correctness fix: when the
// user clicks a row in a deletion-bearing diff, the panel must emit the
// RIGHT coordinate keys through `onLineNavigate`:
//
//   • a `del` (red) row carries only `baseLine` (+ `baseFile`, the base
//     worktree path) — never a head coord. This is what makes a red-line
//     click resolve to the Base entity instead of whatever head sibling
//     happens to share that line number.
//   • an `add` (green) row carries only `headLine` (+ `headFile`).
//   • a `context` row carries BOTH coords (head + base) with both file
//     paths, so the host can resolve head-first and fall back to base.
//   • head and base file paths are DISTINCT absolute paths in diff mode
//     (reconstructed from headWorkspaceRoot/baseWorkspaceRoot + the
//     repo-relative file_new/file_old from /api/diff).
//
// We drive the REAL bodyEl click handler in code_panel.ts by dispatching
// a click on a rendered `.code-panel-line`, and assert the coords object
// the panel passes to `onLineNavigate`. The logic under test (head/base
// key derivation from data-line-head/data-line-base + the per-side file
// path) is pure DOM, so jsdom is the right tier.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CodePanel,
  type CodePanelLineCoords,
  createCodePanel,
} from '../../src/view/code_panel.ts';

// Repo-relative paths the server's /api/diff returns. In a real
// deletion-bearing diff `file_new` may be null (file removed in head);
// here the file survives but a struct was deleted, so both sides exist.
const REPO_REL = 'src/core.rs';
const HEAD_ROOT = '/tmp/head-worktree';
const BASE_ROOT = '/tmp/base-worktree-deadbeef';

// Head source: the `Engine` struct survives, but a `Legacy` struct that
// existed in base was removed. The flat renderer interleaves these as
// context rows around the del hunk.
const HEAD_SOURCE = [
  'pub struct Engine {', // head 1
  '    pub power: u32,', // head 2
  '}', // head 3
].join('\n');

// A deletion-bearing diff payload: base lines 5-7 (the `Legacy` struct)
// are removed; head line 1's struct header is context (present in both).
// del rows carry ONLY `old` (base coord); add rows ONLY `new`; context
// rows carry both.
const DIFF_PAYLOAD = {
  file_old: REPO_REL,
  file_new: REPO_REL,
  hunks: [
    {
      old_start: 1,
      old_count: 7,
      new_start: 1,
      new_count: 3,
      lines: [
        { kind: 'context', text: 'pub struct Engine {', old: 1, new: 1 },
        { kind: 'context', text: '    pub power: u32,', old: 2, new: 2 },
        { kind: 'context', text: '}', old: 3, new: 3 },
        // The removed `Legacy` struct — three del rows, base coords only.
        { kind: 'del', text: 'pub struct Legacy {', old: 5 },
        { kind: 'del', text: '    pub flag: bool,', old: 6 },
        { kind: 'del', text: '}', old: 7 },
        // A lone add row to exercise the add-only path.
        { kind: 'add', text: '// new trailing comment', new: 4 },
      ],
    },
  ],
} as const;

/** Build the `#code-panel` DOM scaffold createCodePanel requires. */
function mountPanelScaffold(): void {
  const root = document.createElement('div');
  root.id = 'code-panel';
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

/** Stub `fetch` for `/api/diff` (200 JSON) and `/api/source` (text). */
function stubFetch(): void {
  vi.stubGlobal('fetch', (input: string): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('/api/diff')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(DIFF_PAYLOAD),
        text: () => Promise.resolve(''),
      } as Response);
    }
    if (url.startsWith('/api/source')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(HEAD_SOURCE),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

/** Open the panel and flush the async diff+source load chain. */
async function showAndSettle(
  panel: CodePanel,
  args: { file: string; startLine: number; endLine: number; loadFromBase?: boolean },
): Promise<HTMLElement> {
  panel.show(args);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return document.querySelector<HTMLElement>('.code-panel-body') as HTMLElement;
}

/** Dispatch a real bubbling click whose target is the given line row's
 *  text span — exactly the event a user click produces. Returns the
 *  coords the panel emitted, or null if `onLineNavigate` did not fire. */
function clickRow(row: HTMLElement): void {
  const target = row.querySelector('.code-panel-text') ?? row;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('code-panel del-line click → coordinate keys (GROUP A)', () => {
  let lastFile: string | null;
  let lastCoords: CodePanelLineCoords | null;
  let navCount: number;

  function makePanel(): CodePanel {
    return createCodePanel({
      diffEnabled: true,
      headWorkspaceRoot: HEAD_ROOT,
      baseWorkspaceRoot: BASE_ROOT,
      onLineNavigate: (file, coords) => {
        navCount += 1;
        lastFile = file;
        lastCoords = coords;
      },
    });
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    mountPanelScaffold();
    stubFetch();
    lastFile = null;
    lastCoords = null;
    navCount = 0;
    // No real text selection in jsdom, but make the guard deterministic.
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as unknown as Selection);
  });

  it('clicking a DEL row emits baseLine + baseFile and NO head coords (click-correctness fix)', async () => {
    const panel = makePanel();
    const body = await showAndSettle(panel, { file: REPO_REL, startLine: 1, endLine: 3 });

    const delRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="del"]');
    expect(delRow, 'a del row rendered').not.toBeNull();
    expect(delRow?.dataset.lineBase).toBe('5');
    expect(delRow?.dataset.lineHead).toBeUndefined();

    clickRow(delRow!);

    expect(navCount).toBe(1);
    expect(lastCoords).not.toBeNull();
    // Base side only — the red line resolves against the BASE index.
    expect(lastCoords?.baseLine).toBe(5);
    expect(lastCoords?.headLine).toBeUndefined();
    // The base path is the BASE worktree absolute path, NOT the head
    // path — a del-line lookup that used the head path would silently
    // miss the Base-only entity.
    expect(lastCoords?.baseFile).toBe(`${BASE_ROOT}/${REPO_REL}`);
    expect(lastCoords?.headFile).toBeUndefined();
  });

  it('clicking an ADD row emits headLine + headFile only', async () => {
    const panel = makePanel();
    const body = await showAndSettle(panel, { file: REPO_REL, startLine: 1, endLine: 3 });

    const addRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="add"]');
    expect(addRow, 'an add row rendered').not.toBeNull();
    expect(addRow?.dataset.lineHead).toBe('4');
    expect(addRow?.dataset.lineBase).toBeUndefined();

    clickRow(addRow!);

    expect(navCount).toBe(1);
    expect(lastCoords?.headLine).toBe(4);
    expect(lastCoords?.baseLine).toBeUndefined();
    expect(lastCoords?.headFile).toBe(`${HEAD_ROOT}/${REPO_REL}`);
    expect(lastCoords?.baseFile).toBeUndefined();
  });

  it('clicking a CONTEXT row emits BOTH head+base coords with both file paths', async () => {
    const panel = makePanel();
    const body = await showAndSettle(panel, { file: REPO_REL, startLine: 1, endLine: 3 });

    // The first hunk context row maps head 1 ↔ base 1.
    const contextRow = Array.from(
      body.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="context"]'),
    ).find((r) => r.dataset.lineHead === '1' && r.dataset.lineBase === '1');
    expect(contextRow, 'a context row carrying both coords').not.toBeUndefined();

    clickRow(contextRow!);

    expect(navCount).toBe(1);
    expect(lastCoords?.headLine).toBe(1);
    expect(lastCoords?.baseLine).toBe(1);
    // Distinct absolute paths per side — the host resolves head-first,
    // base as fallback, each against its own worktree path.
    expect(lastCoords?.headFile).toBe(`${HEAD_ROOT}/${REPO_REL}`);
    expect(lastCoords?.baseFile).toBe(`${BASE_ROOT}/${REPO_REL}`);
    expect(lastCoords?.headFile).not.toBe(lastCoords?.baseFile);
  });

  it('emits the panel file path (head-side currentFile) as the first onLineNavigate arg', async () => {
    const panel = makePanel();
    const body = await showAndSettle(panel, { file: REPO_REL, startLine: 1, endLine: 3 });
    const delRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="del"]')!;
    clickRow(delRow);
    // The first argument is the panel's currentFile (the repo-relative
    // path it was shown with); the per-side paths ride in `coords`.
    expect(lastFile).toBe(REPO_REL);
  });

  it('a click while text is selected is a no-op (does not navigate)', async () => {
    const panel = makePanel();
    const body = await showAndSettle(panel, { file: REPO_REL, startLine: 1, endLine: 3 });
    (window.getSelection as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      toString: () => 'some selected text',
    } as unknown as Selection);

    const delRow = body.querySelector<HTMLElement>('.code-panel-line[data-kind="del"]')!;
    clickRow(delRow);
    expect(navCount).toBe(0);
  });
});
