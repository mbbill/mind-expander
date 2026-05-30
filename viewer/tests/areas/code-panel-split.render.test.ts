// @vitest-environment jsdom
//
// GROUP B — Modified-entity (split-on-change) diff fixture, code-panel
// Tier-1 jsdom DOM-binding tests.
//
// A *Modified* entity is one whose body changed: the diagram resolves it
// to a HEAD span `(file, startLine..endLine)` AND a base `prev_span`
// `(file, start_line..end_line)`. In the flat diff render that produces a
// dual block of red (`del`, base coords) + green (`add`, head coords)
// rows. The product contract (see `CodePanelShowArgs.prev_span` /
// `setHighlight` docblocks in code_panel.ts) is that the purple focus
// frame — the `entity-row` class — wraps BOTH halves so the user sees one
// contiguous frame around the whole change, not just the green side.
//
// This file covers the code-panel side of GROUP B:
//   • setHighlight unifies the frame across head span ∪ base prev_span,
//     and re-tagging with a NEW range drops rows outside it (the
//     idempotent union the host re-applies on every reverse-nav click).
//   • renderDiff respects `entityIsBaseSide`: a Base-side (loadFromBase)
//     entity frames its rows by the BASE coord, not the head coord.
//   • show() is expected — per the prev_span docblock — to unify the
//     frame across head+base on the initial open of a Modified entity.
//     The current renderer ignores `args.prev_span`, so that row is a
//     SUSPECTED BUG and is `it.skip`ed with the correct oracle.
//
// The existing diff-unified-mode.render.test.ts already covers the plain
// setHighlight-union happy path (T-D3); this file covers the
// entityIsBaseSide tagging, the unmatched-row drop, and the show()
// prev_span contract — none of which that file asserts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CodePanel, createCodePanel } from '../../src/view/code_panel.ts';

// ── Modified-entity diff payload ─────────────────────────────────────
// `recompute()` had its body changed: the old body (base lines 2..3)
// was deleted and a new body (head lines 2..4) added. One file, one
// hunk, with `del` rows carrying base coords and `add` rows carrying
// head coords — the split-on-change shape. The hunk spans head lines
// 1..5; head line 6 (`untouched`) is unchanged trailing context.
const DIFF_PAYLOAD = {
  file_old: 'src/lib.rs',
  file_new: 'src/lib.rs',
  hunks: [
    {
      old_start: 1,
      old_count: 4,
      new_start: 1,
      new_count: 5,
      lines: [
        { kind: 'context', text: 'pub fn recompute() -> u32 {', old: 1, new: 1 },
        { kind: 'del', text: '    let x = 1;', old: 2 },
        { kind: 'del', text: '    x', old: 3 },
        { kind: 'add', text: '    let x = 2;', new: 2 },
        { kind: 'add', text: '    let y = 3;', new: 3 },
        { kind: 'add', text: '    x + y', new: 4 },
        { kind: 'context', text: '}', old: 4, new: 5 },
      ],
    },
  ],
} as const;

// Head source for the interleaved-context render. Line 6 is an unchanged
// trailing fn that sits OUTSIDE the modified entity's frame.
const HEAD_SOURCE = [
  'pub fn recompute() -> u32 {', // 1
  '    let x = 2;', //              2
  '    let y = 3;', //              3
  '    x + y', //                   4
  '}', //                           5
  'pub fn untouched() {}', //       6
].join('\n');

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

/** Stub `fetch` for `/api/diff` (200 JSON) and `/api/source` (text). The
 *  `/api/source` stub records the requested URL so a test can assert the
 *  `side=base` param for a Base-side entity. */
let sourceUrls: string[];
function stubFetch(): void {
  sourceUrls = [];
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
      sourceUrls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(HEAD_SOURCE),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

/** Open the panel and flush the async load+render (diff then source). */
async function showAndSettle(
  panel: CodePanel,
  args: { file: string; startLine: number; endLine: number; loadFromBase?: boolean; prev_span?: { file: string; start_line: number; end_line: number } },
): Promise<HTMLElement> {
  panel.show(args);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return document.querySelector<HTMLElement>('.code-panel-body') as HTMLElement;
}

const isEntityRow = (el: HTMLElement | null | undefined): boolean =>
  el?.classList.contains('entity-row') ?? false;

/** All del rows (base-coord change lines), in document order. */
const delRows = (body: HTMLElement): HTMLElement[] =>
  Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="del"]'));
/** All add rows (head-coord change lines), in document order. */
const addRows = (body: HTMLElement): HTMLElement[] =>
  Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line[data-kind="add"]'));

beforeEach(() => {
  document.body.innerHTML = '';
  mountPanelScaffold();
  stubFetch();
});

describe('code-panel split-on-change — setHighlight unifies head ∪ base frame', () => {
  it('frames every add (head) AND every del (base prev_span) row in one union', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    // Open on the head side; the initial render frames only the head
    // rows. The host then re-applies the union via setHighlight.
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 4 });

    // Union: head [2,4] ∪ base prev_span [2,3]. Both del rows (base 2,3)
    // and all add rows (head 2,3,4) must land inside the frame.
    panel.setHighlight({ start_line: 2, end_line: 4 }, { start_line: 2, end_line: 3 });

    const dels = delRows(body);
    const adds = addRows(body);
    expect(dels.length).toBe(2); // non-vacuous: the base half exists
    expect(adds.length).toBe(3); // non-vacuous: the head half exists
    for (const r of dels) expect(isEntityRow(r), `del base ${r.dataset.lineBase}`).toBe(true);
    for (const r of adds) expect(isEntityRow(r), `add head ${r.dataset.lineHead}`).toBe(true);
  });

  it('does NOT frame the unchanged trailing fn outside both ranges', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 4 });
    panel.setHighlight({ start_line: 2, end_line: 4 }, { start_line: 2, end_line: 3 });

    // Head line 6 (`untouched`) is outside head[2,4] and has no base
    // coord, so it must stay un-framed — the frame doesn't bleed.
    const trailing = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line')).find(
      (l) => l.dataset.kind === 'context' && l.dataset.lineHead === '6',
    );
    expect(trailing, 'trailing context row at head line 6').not.toBeUndefined();
    expect(isEntityRow(trailing)).toBe(false);
  });

  it('re-tagging with a new range DROPS rows that fall outside it', async () => {
    // The host calls setHighlight on every reverse-nav click; tagging
    // must be idempotent-replace, not additive. After framing the
    // modified fn, framing a DIFFERENT single line must clear the old
    // entity-rows (otherwise stale purple frames pile up).
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 4 });

    panel.setHighlight({ start_line: 2, end_line: 4 }, { start_line: 2, end_line: 3 });
    expect(delRows(body).some(isEntityRow)).toBe(true); // base half framed

    // Re-frame head line 1 only (the signature context row), no prev_span.
    panel.setHighlight({ start_line: 1, end_line: 1 });

    // The base del rows are now OUTSIDE the frame and must be dropped.
    for (const r of delRows(body)) expect(isEntityRow(r), `del base ${r.dataset.lineBase}`).toBe(false);
    for (const r of addRows(body)) expect(isEntityRow(r), `add head ${r.dataset.lineHead}`).toBe(false);
    // Only the head-line-1 context row remains framed.
    const sig = Array.from(body.querySelectorAll<HTMLElement>('.code-panel-line')).find(
      (l) => l.dataset.lineHead === '1',
    );
    expect(isEntityRow(sig)).toBe(true);
  });
});

describe('code-panel split-on-change — renderDiff honors entityIsBaseSide', () => {
  it('head-side entity (loadFromBase=false) frames rows by HEAD coord', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    // Head span [2,4]; entityIsBaseSide=false. tagEntity keys off the
    // head coord, so the three add rows (head 2,3,4) get framed and the
    // del rows (base 2,3 — no head coord) do NOT.
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 4 });

    const adds = addRows(body);
    expect(adds.length).toBe(3);
    for (const r of adds) expect(isEntityRow(r), `add head ${r.dataset.lineHead}`).toBe(true);
    // Base del rows carry no head coord → not framed in head-side render.
    for (const r of delRows(body)) expect(isEntityRow(r), `del base ${r.dataset.lineBase}`).toBe(false);
  });

  it('base-side entity (loadFromBase=true) frames rows by BASE coord, ignoring head rows', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    // A Base-side (deleted-region) entity: its canonical span is in base
    // coords. Pass the BASE line range as start/end and loadFromBase=true
    // so renderDiff tags by base coord. base [2,3] covers both del rows;
    // the add rows (head coords, no base coord) must stay un-framed.
    const body = await showAndSettle(panel, {
      file: 'src/lib.rs',
      startLine: 2,
      endLine: 3,
      loadFromBase: true,
    });

    const dels = delRows(body);
    expect(dels.length).toBe(2);
    for (const r of dels) expect(isEntityRow(r), `del base ${r.dataset.lineBase}`).toBe(true);
    // Add rows have no base coord → entityIsBaseSide tagging skips them.
    for (const r of addRows(body)) expect(isEntityRow(r), `add head ${r.dataset.lineHead}`).toBe(false);
  });

  it('Prism highlights add/del hunk lines (tokenized, not plain text)', async () => {
    // Each hunk line gets its own Prism pass (base for del, head for
    // add). A `let` keyword in the changed body must render as a Prism
    // token span, not bare text — the per-line highlight contract.
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, { file: 'src/lib.rs', startLine: 2, endLine: 4 });

    const add = addRows(body).find((r) => (r.textContent ?? '').includes('let'));
    expect(add, 'an add row containing `let`').not.toBeUndefined();
    const code = add?.querySelector('.code-panel-text');
    // Prism wraps `let` in a <span class="token keyword">; a plain-text
    // fallback would have no token spans.
    expect(code?.querySelector('.token.keyword')?.textContent).toBe('let');

    const del = delRows(body).find((r) => (r.textContent ?? '').includes('let'));
    expect(del, 'a del row containing `let`').not.toBeUndefined();
    expect(del?.querySelector('.code-panel-text .token.keyword')?.textContent).toBe('let');
  });
});

describe('code-panel split-on-change — show() prev_span contract (SUSPECTED BUG)', () => {
  // CONTRACT (CodePanelShowArgs.prev_span docblock): "When set, the focus
  // frame and entity-row tagging extend across the union of (file,
  // startLine..endLine) and (prev_span.file, prev_span.start_line..
  // end_line) — that's how the dual red+green hunk rows of a modified
  // function end up inside one contiguous purple frame."
  //
  // SUSPECTED BUG: show() never forwards args.prev_span into renderDiff
  // (code_panel.ts ~L621-628 calls renderDiff with startLine/endLine/
  // loadFromBase only). main.ts `openCodeFor` (Cmd+click / "C" key) opens
  // a Modified entity via show({...prev_span}) and does NOT follow up with
  // setHighlight, so on the INITIAL open the deleted base rows sit OUTSIDE
  // the purple frame — the user sees only the green half framed. The base
  // half only joins the frame after a later reverse-nav click triggers
  // setHighlight. This test asserts the documented (correct) behavior and
  // is skipped until show() honors prev_span.
  it.skip('SUSPECTED BUG: show() with prev_span frames the base (del) rows on initial open', async () => {
    const panel = createCodePanel({ onLineNavigate: () => {}, diffEnabled: true });
    const body = await showAndSettle(panel, {
      file: 'src/lib.rs',
      startLine: 2,
      endLine: 4,
      prev_span: { file: 'src/lib.rs', start_line: 2, end_line: 3 },
    });

    // Per the docblock, the del rows (base 2,3) should be framed by the
    // initial show() because prev_span covers them — NO setHighlight yet.
    const dels = delRows(body);
    expect(dels.length).toBe(2);
    for (const r of dels) expect(isEntityRow(r), `del base ${r.dataset.lineBase}`).toBe(true);
    // The head add rows are framed too (head span).
    for (const r of addRows(body)) expect(isEntityRow(r), `add head ${r.dataset.lineHead}`).toBe(true);
  });
});
