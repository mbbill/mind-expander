// Syntax highlighting via Prism. We highlight the full file once and
// then split on \n so multi-line constructs (block comments, raw
// strings) stay coherent across the per-line DOM.
import Prism from 'prismjs';
import 'prismjs/components/prism-rust';
import 'prism-themes/themes/prism-one-light.css';

import {
  type FileTree,
  childrenOf,
  displaySegmentsFor,
} from '../data/file_tree.ts';

// Right-side docked code panel.
//
// The panel is a flex sibling of `#viewer-left` inside `<main>`, so
// its width is subtracted from the diagram pane (`#canvas-scroll`'s
// outer flex item). Opening / closing it via `show()` / `hide()`
// resizes the diagram naturally — no overlap, no z-index gymnastics.
//
// The only interactive geometry left on the panel is the left-edge
// splitter: dragging it adjusts the panel's width and the flex layout
// reflows the diagram live. Width is persisted to localStorage so the
// user's preferred split survives reloads.
//
// Two-way linking lives partly here: clicking a line inside the panel
// fires the host's `onLineNavigate` callback so the diagram can pan
// back to the element defined at that line. The host owns the file-to-
// element index (built at facts-load time) so the panel stays generic.

const STORAGE_KEY = 'mind-expander.code-panel';
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 280;

interface PersistedState {
  readonly w: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface CodePanelShowArgs {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Union-diff side of the entity being shown. When `'base'`, the
   *  panel fetches the file from the base snapshot via
   *  `/api/source?side=base` (so removed modules / types can still
   *  be inspected). Default behaviour is head-side reads. */
  readonly side?: 'base' | 'head' | 'both';
}

export interface CodePanelOptions {
  /** Fired when the user clicks a line in the code body. The host
   *  resolves which element defines that line and navigates the
   *  diagram. Skipped if the user is just selecting text. */
  readonly onLineNavigate: (file: string, line: number) => void;
  /** When true, the panel tries `/api/diff` before `/api/source` and
   *  paints additions/deletions with coloured backgrounds. Set from
   *  `/api/health`'s `diff_enabled` at startup. */
  readonly diffEnabled?: boolean;
  /** Fired when the user closes the panel (X button or hide() call
   *  from outside). The host uses this to clear the diagram's
   *  selection so the two views stay in sync. */
  readonly onClose?: () => void;
  /** Fired when the user picks a file from the title-bar breadcrumb
   *  popup. The host normally responds the same way as a Cmd+click on
   *  the corresponding module — opening the file AND updating the
   *  diagram selection. */
  readonly onShowFile?: (absolutePath: string) => void;
  /** Directory tree built from the workspace's indexed source files.
   *  When present, the title bar renders as a clickable breadcrumb;
   *  segments expose siblings and children via a popup. When omitted,
   *  the title bar falls back to a plain ellipsised path. */
  readonly fileTree?: FileTree;
}

export interface CodePanel {
  show: (args: CodePanelShowArgs) => void;
  /** Open the panel without loading any file. Used by the "C" hotkey
   *  when no diagram element is selected — the user wanted the split
   *  open even if there's nothing to show yet. Subsequent `show()` calls
   *  replace the placeholder with actual source. */
  openEmpty: () => void;
  hide: () => void;
  isOpen: () => boolean;
  /** Replace the highlighted line range without re-fetching the file.
   *  Used by the host when a click inside the panel resolves to a new
   *  element so the visual selection follows the cursor. */
  setHighlight: (startLine: number, endLine: number) => void;
  /** Current on-screen rect of the panel (window coords), or null when
   *  hidden. Lets the tour bubble avoid landing on top of the panel
   *  (it floats above all elements regardless of layout). */
  getScreenRect: () => DOMRect | null;
}

export function createCodePanel(opts: CodePanelOptions): CodePanel {
  const root = document.querySelector<HTMLElement>('#code-panel');
  if (!root) throw new Error('missing #code-panel root element');
  const titleEl = root.querySelector<HTMLElement>('.code-panel-title');
  const closeBtn = root.querySelector<HTMLButtonElement>('.code-panel-close');
  const bodyEl = root.querySelector<HTMLElement>('.code-panel-body');
  const headerEl = root.querySelector<HTMLElement>('.code-panel-header');
  const splitterEl = root.querySelector<HTMLElement>('.code-panel-resize-l');
  if (!titleEl || !closeBtn || !bodyEl || !headerEl || !splitterEl) {
    throw new Error('code-panel missing required child elements');
  }

  let currentFile: string | null = null;
  let currentFileText: string | null = null;
  let inflight: AbortController | null = null;

  // Persisted width. Clamped on load so a smaller window after the
  // last session doesn't strand the panel wider than the viewport
  // (would leave the diagram pane with zero room).
  const loadState = (): PersistedState => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return { w: DEFAULT_WIDTH };
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return { w: typeof parsed.w === 'number' ? parsed.w : DEFAULT_WIDTH };
    } catch {
      return { w: DEFAULT_WIDTH };
    }
  };
  const saveState = (s: PersistedState): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* ignore quota errors */
    }
  };
  let state = loadState();
  const applyWidth = (): void => {
    // Leave at least 200px for the diagram pane so the diagram never
    // collapses to nothing when the user drags the splitter all the way.
    const maxW = Math.max(MIN_WIDTH, window.innerWidth - 200);
    state = { w: Math.min(Math.max(MIN_WIDTH, state.w), maxW) };
    root.style.setProperty('--code-panel-w', `${state.w}px`);
    root.style.width = `${state.w}px`;
  };
  applyWidth();

  // Splitter on the panel's LEFT edge. Dragging it left grows the
  // panel (and shrinks the diagram pane); dragging right does the
  // inverse. Width is computed from the panel's right edge minus the
  // cursor position so the right edge stays glued to the viewport
  // edge while only the left side moves.
  let resize: { id: number; rightEdge: number } | null = null;
  splitterEl.addEventListener('pointerdown', (e) => {
    const rect = root.getBoundingClientRect();
    resize = { id: e.pointerId, rightEdge: rect.right };
    splitterEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  splitterEl.addEventListener('pointermove', (e) => {
    if (resize === null || e.pointerId !== resize.id) return;
    const newW = resize.rightEdge - e.clientX;
    state = { w: newW };
    applyWidth();
  });
  const endResize = (e: PointerEvent): void => {
    if (resize === null || e.pointerId !== resize.id) return;
    if (splitterEl.hasPointerCapture(e.pointerId)) splitterEl.releasePointerCapture(e.pointerId);
    resize = null;
    saveState(state);
  };
  splitterEl.addEventListener('pointerup', endResize);
  splitterEl.addEventListener('pointercancel', endResize);

  closeBtn.addEventListener('click', () => {
    hide();
  });

  // Click on a line in the code body → fire onLineNavigate. Skip when
  // the user is dragging out a text selection (don't hijack copy).
  bodyEl.addEventListener('click', (e) => {
    const sel = window.getSelection();
    if (sel !== null && sel.toString().length > 0) return;
    const lineEl = (e.target as HTMLElement).closest<HTMLElement>('.code-panel-line');
    if (lineEl === null || currentFile === null) return;
    const line = Number(lineEl.dataset.line);
    if (Number.isFinite(line) && line > 0) {
      opts.onLineNavigate(currentFile, line);
    }
  });

  // Focus frame — a purple dashed overlay that wraps the rows of
  // the clicked entity. Same visual language as the SVG type-box
  // selection ring; composes cleanly with diff-mode row backgrounds
  // because it's a separate absolutely-positioned layer instead of
  // a per-row background. Call after every body re-render or
  // .entity-row class change.
  const drawFocusFrame = (): void => {
    const old = bodyEl.querySelector<HTMLElement>('.code-panel-entity-frame');
    if (old !== null) old.remove();
    const rows = bodyEl.querySelectorAll<HTMLElement>('.code-panel-line.entity-row');
    if (rows.length === 0) return;
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const top = first.offsetTop - 2;
    const height = last.offsetTop + last.offsetHeight - first.offsetTop + 4;
    const frame = document.createElement('div');
    frame.className = 'code-panel-entity-frame';
    frame.style.top = `${top}px`;
    frame.style.height = `${height}px`;
    bodyEl.appendChild(frame);
  };

  const render = (text: string, startLine: number, endLine: number): void => {
    // Highlight the whole file once with Prism (Rust grammar), then
    // split the resulting HTML on \n. Splitting after highlighting is
    // what keeps multi-line block comments and raw strings rendering
    // correctly across the per-line gutter layout.
    const grammar = Prism.languages.rust;
    const highlighted =
      grammar !== undefined
        ? Prism.highlight(text, grammar, 'rust')
        : escapeHtml(text);
    const lineHtml = highlighted.split('\n');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lineHtml.length; i++) {
      const lineNum = i + 1;
      const lineEl = document.createElement('div');
      lineEl.className = 'code-panel-line';
      lineEl.dataset.line = String(lineNum);
      if (lineNum >= startLine && lineNum <= endLine) {
        lineEl.classList.add('entity-row');
      }
      const gutter = document.createElement('span');
      gutter.className = 'code-panel-gutter';
      gutter.textContent = String(lineNum);
      const code = document.createElement('span');
      code.className = 'code-panel-text';
      code.innerHTML = lineHtml[i] ?? '';
      lineEl.appendChild(gutter);
      lineEl.appendChild(code);
      frag.appendChild(lineEl);
    }
    bodyEl.replaceChildren(frag);
    const target = bodyEl.querySelector<HTMLElement>('.code-panel-line.entity-row');
    if (target !== null) {
      // Position the focus ~25% from the top of the panel body so
      // there's breathing room above for the surrounding context.
      const offsetTop = target.offsetTop - bodyEl.clientHeight * 0.25;
      bodyEl.scrollTop = Math.max(0, offsetTop);
    } else {
      bodyEl.scrollTop = 0;
    }
    drawFocusFrame();
  };

  const fetchSource = async (
    file: string,
    signal: AbortSignal,
    side?: 'base' | 'head' | 'both',
  ): Promise<string> => {
    // Base-side fetches go through `git show <base_sha>:<path>` on the
    // server — bypasses the head workspace's filesystem entirely so
    // removed entities (which don't exist in head) still render.
    const sideParam = side === 'base' ? '&side=base' : '';
    const res = await fetch(
      `/api/source?path=${encodeURIComponent(file)}${sideParam}`,
      { signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.text();
  };

  // Diff fetch returns one of:
  //   - { ok: true, diff: DiffPayload } — server returned 200 with hunks
  //   - { ok: false, unchanged: true } — server returned 204 (file is
  //       unchanged in this diff); caller falls back to source mode
  //   - { ok: false, unchanged: false } — server returned 404 or 5xx;
  //       caller falls back to source mode (e.g., diff endpoint missing
  //       in older server, or file outside repo).
  type DiffLineKind = 'context' | 'add' | 'del';
  interface DiffLine {
    readonly kind: DiffLineKind;
    readonly text: string;
    readonly old?: number;
    readonly new?: number;
  }
  interface DiffHunk {
    readonly old_start: number;
    readonly old_count: number;
    readonly new_start: number;
    readonly new_count: number;
    readonly lines: readonly DiffLine[];
  }
  interface DiffPayload {
    readonly file_old: string | null;
    readonly file_new: string | null;
    readonly hunks: readonly DiffHunk[];
  }
  type DiffFetchResult =
    | { ok: true; diff: DiffPayload }
    | { ok: false; unchanged: boolean };

  const fetchDiff = async (
    file: string,
    signal: AbortSignal,
  ): Promise<DiffFetchResult> => {
    const res = await fetch(`/api/diff?path=${encodeURIComponent(file)}`, { signal });
    if (res.status === 204) return { ok: false, unchanged: true };
    if (!res.ok) return { ok: false, unchanged: false };
    const diff = (await res.json()) as DiffPayload;
    return { ok: true, diff };
  };

  // Diff renderer — distinct from `render()` because the line stream is
  // hunk-driven (not 1:1 with the file) and each line gets its own
  // Prism pass (lines come from different snapshots — base for `-`,
  // head for `+`/context — so a single whole-file highlight pass would
  // mis-tokenize across the boundary).
  // Inline-diff renderer. Each line:
  //   [bar][old#][new#] content
  // with a full-row tint matching the bar color. The bar lives on
  // the row's left edge via CSS `border-left`; the old/new gutters
  // are two narrow text columns; the content is syntax-highlighted
  // per-line (lines come from different snapshots — base for `-`,
  // head for `+`/context — so a single whole-file highlight would
  // mis-tokenize across the boundary).
  //
  // `entityStart`/`entityEnd` (when provided) describe the entity
  // the user clicked, in HEAD line numbers. Rows that fall inside
  // this range get an `entity-row` class so CSS can paint a soft
  // accent + the row is the scroll target.
  const renderDiff = (
    diff: DiffPayload,
    entityStart?: number,
    entityEnd?: number,
    entityIsBaseSide?: boolean,
    expandHandler?: (
      marker: HTMLElement,
      gapStart: number,
      gapEnd: number,
    ) => void,
  ): void => {
    const grammar = Prism.languages.rust;
    const highlightOne = (text: string): string =>
      grammar !== undefined ? Prism.highlight(text, grammar, 'rust') : escapeHtml(text);
    const frag = document.createDocumentFragment();
    const mkCollapse = (n: number, gapStart: number, gapEnd: number, suffix: string): HTMLElement => {
      const c = document.createElement('div');
      c.className = 'code-panel-collapse';
      c.dataset.gapStart = String(gapStart);
      c.dataset.gapEnd = String(gapEnd);
      c.title = 'Click to expand';
      // `canonicalText` stays stable across loading/error transitions
      // so the expand handler can always reset the marker to its
      // original phrasing — otherwise an "(failed to load — click to
      // retry)" suffix would accumulate on every retry.
      const canonical = `… ${n} unchanged line${n === 1 ? '' : 's'}${suffix} — click to expand …`;
      c.dataset.canonicalText = canonical;
      c.textContent = canonical;
      if (expandHandler !== undefined) {
        c.addEventListener('click', () => {
          expandHandler(c, gapStart, gapEnd);
        });
      }
      return c;
    };
    for (let hi = 0; hi < diff.hunks.length; hi++) {
      const hunk = diff.hunks[hi]!;
      // Collapse marker between non-adjacent hunks. The first hunk
      // also gets one if it doesn't start at line 1.
      const prev = hi === 0 ? null : diff.hunks[hi - 1]!;
      const gapStart = prev !== null ? prev.new_start + prev.new_count : 1;
      const gapEnd = hunk.new_start;
      if (gapEnd > gapStart) {
        frag.appendChild(mkCollapse(gapEnd - gapStart, gapStart, gapEnd, ''));
      } else if (hi === 0 && hunk.new_start > 1) {
        frag.appendChild(mkCollapse(hunk.new_start - 1, 1, hunk.new_start, ' above'));
      }
      for (const line of hunk.lines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'code-panel-line';
        lineEl.dataset.kind = line.kind;
        // dataset.line drives click-to-navigate: prefer the head
        // (new) number so a clicked diff line jumps to the current
        // code; fall back to old for pure deletions.
        const navLine = line.new ?? line.old ?? 0;
        if (navLine > 0) lineEl.dataset.line = String(navLine);
        // Mark this row as belonging to the clicked entity. Match
        // by the line side the entity lives on (head for normal/
        // added/modified, base for removed entities).
        if (entityStart !== undefined && entityEnd !== undefined) {
          const ref = entityIsBaseSide ? line.old : line.new;
          if (ref !== undefined && ref >= entityStart && ref <= entityEnd) {
            lineEl.classList.add('entity-row');
          }
        }
        const oldGutter = document.createElement('span');
        oldGutter.className = 'code-panel-gutter old';
        oldGutter.textContent = line.old !== undefined ? String(line.old) : '';
        const newGutter = document.createElement('span');
        newGutter.className = 'code-panel-gutter new';
        newGutter.textContent = line.new !== undefined ? String(line.new) : '';
        const code = document.createElement('span');
        code.className = 'code-panel-text';
        code.innerHTML = highlightOne(line.text);
        lineEl.appendChild(oldGutter);
        lineEl.appendChild(newGutter);
        lineEl.appendChild(code);
        frag.appendChild(lineEl);
      }
    }
    bodyEl.replaceChildren(frag);
    // Scroll-to-entity: pin the first row of the entity ~25% from
    // the top, mirroring source-mode behaviour. Fall back to the
    // first diff line if the entity isn't in view (e.g. the diff is
    // entirely outside its span — shouldn't happen for changed
    // entities but be defensive).
    const target =
      bodyEl.querySelector<HTMLElement>('.code-panel-line.entity-row') ??
      bodyEl.querySelector<HTMLElement>('.code-panel-line[data-kind="add"], .code-panel-line[data-kind="del"]');
    if (target !== null) {
      const offsetTop = target.offsetTop - bodyEl.clientHeight * 0.25;
      bodyEl.scrollTop = Math.max(0, offsetTop);
    } else {
      bodyEl.scrollTop = 0;
    }
    drawFocusFrame();
  };

  const show = (args: CodePanelShowArgs): void => {
    root.hidden = false;
    renderTitle(args.file);
    // Source-mode reuse: same-file clicks just re-highlight. Diff mode
    // doesn't share this cache because the line stream is hunk-driven,
    // not file-driven; re-fetch is cheap (entity-scoped) so we skip
    // the optimization for now.
    if (!opts.diffEnabled && currentFile === args.file && currentFileText !== null) {
      render(currentFileText, args.startLine, args.endLine);
      return;
    }
    bodyEl.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'code-panel-loading',
        textContent: 'Loading…',
      }),
    );
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    // Always try diff first in diff mode, regardless of entity side.
    // Files newly added in head come back as an all-`+` diff; files
    // deleted in head come back as all-`-`. Both render as their
    // respective tints — the user always sees the diff. Fall back to
    // source only on 204 (file genuinely unchanged) or 404 (file
    // outside the git repo, etc.) — the rare cases where there's no
    // diff signal to show.
    const loadAndRender = async (): Promise<void> => {
      if (opts.diffEnabled) {
        const dr = await fetchDiff(args.file, signal);
        if (signal.aborted) return;
        if (dr.ok) {
          // Also fetch the head source so the user can expand
          // collapse markers and see the unchanged context lines
          // inline. We do this in parallel (already past the diff
          // fetch) and cache it; the expand handler reads it.
          let sourceLines: string[] | null = null;
          const ensureSource = async (): Promise<string[] | null> => {
            if (sourceLines !== null) return sourceLines;
            try {
              const text = await fetchSource(args.file, signal);
              if (signal.aborted) return null;
              sourceLines = text.split('\n');
              return sourceLines;
            } catch {
              return null;
            }
          };
          const grammar = Prism.languages.rust;
          const highlightOne = (text: string): string =>
            grammar !== undefined
              ? Prism.highlight(text, grammar, 'rust')
              : escapeHtml(text);
          const expand = async (
            marker: HTMLElement,
            gapStart: number,
            gapEnd: number,
          ): Promise<void> => {
            // Render visible feedback so the click never feels
            // silently swallowed. We read the canonical text from
            // the marker's data attr (not its current textContent)
            // so retries reset to the original phrasing instead of
            // accumulating "(failed to load — click to retry)"
            // suffixes on every click.
            const canonical = marker.dataset.canonicalText ?? marker.textContent ?? '';
            marker.textContent = `… loading ${gapEnd - gapStart} lines …`;
            let lines: string[] | null = null;
            try {
              lines = await ensureSource();
            } catch (err) {
              console.error('[code-panel] expand fetch threw', err);
            }
            if (lines === null) {
              marker.textContent = `${canonical} (failed to load — click to retry)`;
              return;
            }
            const frag = document.createDocumentFragment();
            // Source lines are 0-indexed; gap line numbers are
            // 1-indexed head-side. Slice the inclusive range.
            for (let n = gapStart; n < gapEnd; n++) {
              const text = lines[n - 1] ?? '';
              const lineEl = document.createElement('div');
              lineEl.className = 'code-panel-line';
              lineEl.dataset.kind = 'context';
              lineEl.dataset.line = String(n);
              const oldGutter = document.createElement('span');
              oldGutter.className = 'code-panel-gutter old';
              oldGutter.textContent = String(n);
              const newGutter = document.createElement('span');
              newGutter.className = 'code-panel-gutter new';
              newGutter.textContent = String(n);
              const code = document.createElement('span');
              code.className = 'code-panel-text';
              code.innerHTML = highlightOne(text);
              lineEl.appendChild(oldGutter);
              lineEl.appendChild(newGutter);
              lineEl.appendChild(code);
              frag.appendChild(lineEl);
            }
            marker.replaceWith(frag);
          };
          currentFile = args.file;
          currentFileText = null; // invalidate source cache
          renderDiff(
            dr.diff,
            args.startLine,
            args.endLine,
            args.side === 'base',
            expand,
          );
          return;
        }
      }
      const text = await fetchSource(args.file, signal, args.side);
      if (signal.aborted) return;
      currentFile = args.file;
      currentFileText = text;
      render(text, args.startLine, args.endLine);
    };

    loadAndRender().catch((err) => {
      if (signal.aborted) return;
      bodyEl.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'code-panel-error',
          textContent: `Failed to load ${args.file}: ${(err as Error).message}`,
        }),
      );
    });
  };

  // Open the split with no file loaded. If a file was previously
  // shown, leave its body in place so closing/reopening doesn't lose
  // the user's scroll position. Otherwise paint a brief placeholder
  // so the body isn't empty.
  const openEmpty = (): void => {
    if (!root.hidden) return;
    root.hidden = false;
    if (currentFile === null) {
      titleEl.replaceChildren(document.createTextNode('source'));
      titleEl.title = '';
      bodyEl.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'code-panel-loading',
          textContent: 'No source selected — click a diagram element to load its source here.',
        }),
      );
    }
  };

  const hide = (): void => {
    const wasOpen = !root.hidden;
    inflight?.abort();
    inflight = null;
    closePopup();
    root.hidden = true;
    if (wasOpen) opts.onClose?.();
  };

  // Title-bar rendering. With a file tree the title becomes a VS Code-
  // style breadcrumb: each segment is a clickable button that opens a
  // small popup listing the children at that depth (folders first,
  // files second). Without a tree, fall back to plain text.
  let popupEl: HTMLDivElement | null = null;
  const closePopup = (): void => {
    if (popupEl !== null) {
      popupEl.remove();
      popupEl = null;
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    }
  };
  const onDocMouseDown = (e: MouseEvent): void => {
    if (popupEl === null) return;
    if (popupEl.contains(e.target as Node)) return;
    closePopup();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closePopup();
  };

  const openPopupAt = (
    anchor: HTMLElement,
    dirPath: string,
    currentChildPath: string | null,
  ): void => {
    closePopup();
    if (opts.fileTree === undefined) return;
    popupEl = document.createElement('div');
    popupEl.className = 'code-panel-breadcrumb-popup';

    const expanded = new Set<string>();
    void currentChildPath;

    const treeContainer = document.createElement('div');
    popupEl.appendChild(treeContainer);

    const renderTree = (): void => {
      treeContainer.replaceChildren();
      const tree = opts.fileTree;
      if (tree === undefined) return;
      const children = childrenOf(tree, dirPath);
      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'code-panel-breadcrumb-popup-empty';
        empty.textContent = '(nothing indexed)';
        treeContainer.appendChild(empty);
        return;
      }
      const renderLevel = (
        parent: HTMLElement,
        nodes: readonly FileTreeChild[],
        depth: number,
      ): void => {
        for (const child of nodes) {
          const row = document.createElement('div');
          row.className = 'code-panel-breadcrumb-popup-row';
          row.style.paddingLeft = `${10 + depth * 14}px`;
          const chevron = document.createElement('span');
          chevron.className = 'code-panel-breadcrumb-popup-chevron';
          if (child.isFile) {
            chevron.classList.add('is-file');
          } else {
            chevron.textContent = '›';
            if (expanded.has(child.absolutePath)) chevron.classList.add('open');
          }
          const label = document.createElement('span');
          label.textContent = child.name;
          row.appendChild(chevron);
          row.appendChild(label);
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (child.isFile) {
              closePopup();
              if (opts.onShowFile !== undefined) {
                opts.onShowFile(child.absolutePath);
              } else {
                show({ file: child.absolutePath, startLine: 1, endLine: 1 });
              }
              return;
            }
            if (expanded.has(child.absolutePath)) {
              expanded.delete(child.absolutePath);
            } else {
              expanded.add(child.absolutePath);
            }
            renderTree();
          });
          parent.appendChild(row);
          if (!child.isFile && expanded.has(child.absolutePath)) {
            const sub = childrenOf(tree, child.absolutePath);
            if (sub.length > 0) renderLevel(parent, sub, depth + 1);
          }
        }
      };
      renderLevel(treeContainer, children, 0);
    };
    renderTree();

    document.body.appendChild(popupEl);
    const rect = anchor.getBoundingClientRect();
    popupEl.style.left = `${rect.left}px`;
    popupEl.style.top = `${rect.bottom + 2}px`;
    const popupRect = popupEl.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 8) {
      popupEl.style.left = `${Math.max(8, window.innerWidth - popupRect.width - 8)}px`;
    }
    if (popupRect.bottom > window.innerHeight - 8) {
      popupEl.style.top = `${Math.max(8, rect.top - popupRect.height - 2)}px`;
    }
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
  };

  type FileTreeChild = ReturnType<typeof childrenOf>[number];

  const renderTitle = (filePath: string): void => {
    closePopup();
    if (opts.fileTree === undefined) {
      titleEl.replaceChildren(document.createTextNode(filePath));
      titleEl.title = filePath;
      return;
    }
    // In unified-diff mode the file tree's display root is the
    // parent of both worktree-sha dirs (since both base and head
    // share that prefix). That leaves the SHA as the first
    // breadcrumb segment, which is both ugly and meaningless —
    // we're showing a diff, not a fixed snapshot. Filter out any
    // 40-char hex segment so the breadcrumb starts at the crate
    // name (`sf-nano-core > src > ...`).
    const isSha = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);
    const segments = displaySegmentsFor(opts.fileTree, filePath).filter(
      (s) => !isSha(s.name),
    );
    titleEl.replaceChildren();
    titleEl.title = filePath;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === undefined) continue;
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'code-panel-crumb-sep';
        sep.textContent = '›';
        titleEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-panel-crumb';
      if (seg.isFile) btn.classList.add('is-file');
      btn.textContent = seg.name;
      if (!seg.isFile) {
        const next = segments[i + 1];
        const currentChild = next?.cumulativePath ?? null;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openPopupAt(btn, seg.cumulativePath, currentChild);
        });
      }
      titleEl.appendChild(btn);
    }
  };

  const setHighlight = (startLine: number, endLine: number): void => {
    // Toggle the entity-row class to update which lines belong to
    // the focused entity, then redraw the wrapping purple dashed
    // frame to match the new bounds.
    const lines = bodyEl.querySelectorAll<HTMLElement>('.code-panel-line');
    lines.forEach((el) => {
      const n = Number(el.dataset.line);
      if (Number.isFinite(n) && n >= startLine && n <= endLine) {
        el.classList.add('entity-row');
      } else {
        el.classList.remove('entity-row');
      }
    });
    drawFocusFrame();
  };

  const getScreenRect = (): DOMRect | null =>
    root.hidden ? null : root.getBoundingClientRect();

  return {
    show,
    openEmpty,
    hide,
    isOpen: () => !root.hidden,
    setHighlight,
    getScreenRect,
  };
}
