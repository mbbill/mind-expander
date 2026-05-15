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

// Floating, draggable code panel.
//
// Shows the source for a clicked diagram element — Cmd/Ctrl+click on a
// type/field/method chip opens this panel scrolled to the element's
// definition. The panel lives in screen-space (fixed position), is
// draggable by its header, and persists size + position to localStorage
// so it sticks where the user puts it.
//
// Two-way linking lives partly here: clicking a line inside the panel
// fires the host\'s `onLineNavigate` callback so the diagram can pan
// back to the element defined at that line. The host owns the file-to-
// element index (built at facts-load time) so the panel stays generic.

const STORAGE_KEY = 'mind-expander.code-panel';

interface PersistedState {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_STATE: PersistedState = { x: 80, y: 100, w: 520, h: 480 };

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
}

export interface CodePanelOptions {
  /** Fired when the user clicks a line in the code body. The host
   *  resolves which element defines that line and navigates the
   *  diagram. Skipped if the user is just selecting text. */
  readonly onLineNavigate: (file: string, line: number) => void;
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
  hide: () => void;
  isOpen: () => boolean;
  /** Replace the highlighted line range without re-fetching the file.
   *  Used by the host when a click inside the panel resolves to a new
   *  element so the visual selection follows the cursor. */
  setHighlight: (startLine: number, endLine: number) => void;
  /** Current on-screen rect of the panel (window coords), or null when
   *  hidden. Lets the diagram's navigation logic avoid scrolling a
   *  focused element behind the panel — the panel reports where it is,
   *  the navigator decides where to land the focus. */
  getScreenRect: () => DOMRect | null;
}

export function createCodePanel(opts: CodePanelOptions): CodePanel {
  const root = document.querySelector<HTMLElement>('#code-panel');
  if (!root) throw new Error('missing #code-panel root element');
  const titleEl = root.querySelector<HTMLElement>('.code-panel-title');
  const closeBtn = root.querySelector<HTMLButtonElement>('.code-panel-close');
  const bodyEl = root.querySelector<HTMLElement>('.code-panel-body');
  const headerEl = root.querySelector<HTMLElement>('.code-panel-header');
  const resizerBrEl = root.querySelector<HTMLElement>('.code-panel-resize-br');
  const resizerBlEl = root.querySelector<HTMLElement>('.code-panel-resize-bl');
  const resizerLEl = root.querySelector<HTMLElement>('.code-panel-resize-l');
  const resizerREl = root.querySelector<HTMLElement>('.code-panel-resize-r');
  const resizerBEl = root.querySelector<HTMLElement>('.code-panel-resize-b');
  if (
    !titleEl ||
    !closeBtn ||
    !bodyEl ||
    !headerEl ||
    !resizerBrEl ||
    !resizerBlEl ||
    !resizerLEl ||
    !resizerREl ||
    !resizerBEl
  ) {
    throw new Error('code-panel missing required child elements');
  }

  let currentFile: string | null = null;
  let currentFileText: string | null = null;
  let inflight: AbortController | null = null;

  // Apply saved position + size on first open. Saved values are
  // clamped to the viewport so a smaller window after the last session
  // doesn\'t leave the panel offscreen.
  const loadState = (): PersistedState => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return DEFAULT_STATE;
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        x: typeof parsed.x === 'number' ? parsed.x : DEFAULT_STATE.x,
        y: typeof parsed.y === 'number' ? parsed.y : DEFAULT_STATE.y,
        w: typeof parsed.w === 'number' ? parsed.w : DEFAULT_STATE.w,
        h: typeof parsed.h === 'number' ? parsed.h : DEFAULT_STATE.h,
      };
    } catch {
      return DEFAULT_STATE;
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
  // Declared up here (rather than next to the drag handler that owns
  // it) because `applyState` reads it on first invocation just below.
  let collapsed = false;
  const applyState = (): void => {
    const maxX = Math.max(0, window.innerWidth - 100);
    const maxY = Math.max(0, window.innerHeight - 60);
    state = {
      x: Math.min(Math.max(0, state.x), maxX),
      y: Math.min(Math.max(0, state.y), maxY),
      w: Math.min(Math.max(280, state.w), window.innerWidth),
      h: Math.min(Math.max(180, state.h), window.innerHeight),
    };
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${state.w}px`;
    // When the panel is folded the inline height represents the
    // header-only collapsed value (set by `setCollapsed`). Writing
    // `state.h` here on drag would override that and pop the body
    // back open mid-drag — keep the collapsed height intact.
    if (!collapsed) root.style.height = `${state.h}px`;
  };
  applyState();

  // Drag the header to move the panel. Pointerup without significant
  // motion is treated as a click on the title bar's empty area, which
  // toggles the panel's collapsed (header-only) state.
  let animClearTimer: number | null = null;
  const setCollapsed = (c: boolean): void => {
    if (collapsed === c) return;
    collapsed = c;
    // Enable the height transition just for this toggle. Normal
    // drag/resize updates run without `.is-animating` so they stay
    // instant — only this state change animates.
    root.classList.add('is-animating');
    root.classList.toggle('is-collapsed', c);
    root.style.height = c
      ? `${headerEl.getBoundingClientRect().height}px`
      : `${state.h}px`;
    if (animClearTimer !== null) window.clearTimeout(animClearTimer);
    animClearTimer = window.setTimeout(() => {
      root.classList.remove('is-animating');
      animClearTimer = null;
    }, 220);
  };
  const DRAG_THRESHOLD_PX = 3;
  let drag: {
    readonly id: number;
    offX: number;
    offY: number;
    readonly startX: number;
    readonly startY: number;
    moved: boolean;
  } | null = null;
  headerEl.addEventListener('pointerdown', (e) => {
    // Skip interactive children — `e.preventDefault()` below would
    // otherwise suppress the synthesized click on close button and
    // breadcrumb chips.
    const target = e.target as HTMLElement;
    if (
      target.closest('.code-panel-close') !== null ||
      target.closest('.code-panel-crumb') !== null
    ) {
      return;
    }
    drag = {
      id: e.pointerId,
      offX: e.clientX - state.x,
      offY: e.clientY - state.y,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    headerEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.id) return;
    if (
      !drag.moved &&
      (Math.abs(e.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - drag.startY) > DRAG_THRESHOLD_PX)
    ) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    state = { ...state, x: e.clientX - drag.offX, y: e.clientY - drag.offY };
    applyState();
  });
  const endDrag = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.id) return;
    if (headerEl.hasPointerCapture(e.pointerId)) headerEl.releasePointerCapture(e.pointerId);
    const wasMoved = drag.moved;
    drag = null;
    if (wasMoved) {
      saveState(state);
    } else if (e.type === 'pointerup') {
      // Header click without drag → toggle the panel's collapsed
      // state. Lets the user park the panel as a thin title bar and
      // re-expand by clicking it again, without affecting drag.
      setCollapsed(!collapsed);
    }
  };
  headerEl.addEventListener('pointerup', endDrag);
  headerEl.addEventListener('pointercancel', endDrag);

  // Resize from any edge or bottom corner. Right/bottom edges keep
  // their adjacent edge anchored; the left edge keeps the right edge
  // anchored and moves `x` left as the panel widens (same as how the
  // bottom-left corner already worked). Combined edge motions live
  // in the two corner handles, which override edge cursors at the
  // intersections.
  type ResizeMode = 'br' | 'bl' | 'l' | 'r' | 'b';
  type ResizeState = {
    readonly id: number;
    readonly mode: ResizeMode;
    readonly startW: number;
    readonly startH: number;
    readonly startX: number;
    readonly startY: number;
    readonly startStateX: number;
  };
  let resize: ResizeState | null = null;

  const startResize = (handle: HTMLElement, mode: ResizeMode): void => {
    handle.addEventListener('pointerdown', (e) => {
      resize = {
        id: e.pointerId,
        mode,
        startW: state.w,
        startH: state.h,
        startX: e.clientX,
        startY: e.clientY,
        startStateX: state.x,
      };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (resize === null || e.pointerId !== resize.id) return;
      const dx = e.clientX - resize.startX;
      const dy = e.clientY - resize.startY;
      const minW = 280;
      switch (resize.mode) {
        case 'r':
          state = { ...state, w: resize.startW + dx };
          break;
        case 'b':
          state = { ...state, h: resize.startH + dy };
          break;
        case 'br':
          state = { ...state, w: resize.startW + dx, h: resize.startH + dy };
          break;
        case 'l':
        case 'bl': {
          // Anchor the right edge (startStateX + startW) and let `x`
          // travel left as `w` grows. Same math for both because the
          // corner just adds vertical motion on top.
          const rightEdge = resize.startStateX + resize.startW;
          const newW = Math.max(minW, resize.startW - dx);
          const newX = rightEdge - newW;
          const newH = resize.mode === 'bl' ? resize.startH + dy : state.h;
          state = { ...state, x: newX, w: newW, h: newH };
          break;
        }
      }
      applyState();
    });
    const endResize = (e: PointerEvent): void => {
      if (resize === null || e.pointerId !== resize.id) return;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      resize = null;
      saveState(state);
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  };
  startResize(resizerBrEl, 'br');
  startResize(resizerBlEl, 'bl');
  startResize(resizerLEl, 'l');
  startResize(resizerREl, 'r');
  startResize(resizerBEl, 'b');

  closeBtn.addEventListener('click', () => {
    hide();
  });

  // Click on a line in the code body → fire onLineNavigate. Skip when
  // the user is dragging out a text selection (don\'t hijack copy).
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

  const render = (text: string, startLine: number, endLine: number): void => {
    // Highlight the whole file once with Prism (Rust grammar), then
    // split the resulting HTML on \n. Splitting after highlighting is
    // what keeps multi-line block comments and raw strings rendering
    // correctly across the per-line gutter layout.
    // Prism's grammar table is typed as possibly-undefined per language.
    // The Rust grammar is imported above, so it's present at runtime;
    // the fallback to plain-text keeps the panel functional if some
    // build configuration ever drops the import.
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
        lineEl.classList.add('highlight');
      }
      const gutter = document.createElement('span');
      gutter.className = 'code-panel-gutter';
      gutter.textContent = String(lineNum);
      const code = document.createElement('span');
      code.className = 'code-panel-text';
      // Highlighted HTML is escaped by Prism for non-token text, so
      // setting innerHTML is safe here. Empty string when the line
      // is blank — fine as innerHTML.
      code.innerHTML = lineHtml[i] ?? '';
      lineEl.appendChild(gutter);
      lineEl.appendChild(code);
      frag.appendChild(lineEl);
    }
    bodyEl.replaceChildren(frag);
    // Scroll the highlighted span into view. Use the first highlighted
    // line as the anchor; align near the top so the user sees the
    // beginning of the item plus context below.
    const target = bodyEl.querySelector<HTMLElement>('.code-panel-line.highlight');
    if (target !== null) {
      // Position the highlight ~25% from the top of the panel body so
      // there\'s breathing room above for the surrounding context.
      const offsetTop = target.offsetTop - bodyEl.clientHeight * 0.25;
      bodyEl.scrollTop = Math.max(0, offsetTop);
    } else {
      bodyEl.scrollTop = 0;
    }
  };

  const fetchSource = async (file: string, signal: AbortSignal): Promise<string> => {
    const res = await fetch(`/api/source?path=${encodeURIComponent(file)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.text();
  };

  const show = (args: CodePanelShowArgs): void => {
    root.hidden = false;
    // Re-show the body if the panel was previously folded — the
    // caller asked to display content, so a collapsed (header-only)
    // state would silently swallow the request.
    if (collapsed) setCollapsed(false);
    renderTitle(args.file);
    // Reuse cached text if same file — common when the user clicks
    // multiple items in the same module.
    if (currentFile === args.file && currentFileText !== null) {
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
    fetchSource(args.file, signal)
      .then((text) => {
        if (signal.aborted) return;
        currentFile = args.file;
        currentFileText = text;
        render(text, args.startLine, args.endLine);
      })
      .catch((err) => {
        if (signal.aborted) return;
        bodyEl.replaceChildren(
          Object.assign(document.createElement('div'), {
            className: 'code-panel-error',
            textContent: `Failed to load ${args.file}: ${(err as Error).message}`,
          }),
        );
      });
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

    // Tree expansion state local to this popup. Everything starts
    // collapsed (matches VS Code's breadcrumb popup behaviour); folder
    // clicks toggle and re-render. `currentChildPath` is intentionally
    // ignored here — the user opens what they want to see.
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
    // Clamp to viewport.
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
    const segments = displaySegmentsFor(opts.fileTree, filePath);
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
        // Folder segment: clicking opens a popup of its contents.
        // The current path's NEXT segment is rendered "highlighted"
        // in the popup so the user sees where they are.
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
    // Repaint just the highlight class — much cheaper than re-rendering
    // every line and (more importantly) preserves scroll position so
    // the user keeps looking at the same code after clicking.
    const lines = bodyEl.querySelectorAll<HTMLElement>('.code-panel-line');
    lines.forEach((el) => {
      const n = Number(el.dataset.line);
      if (Number.isFinite(n) && n >= startLine && n <= endLine) {
        el.classList.add('highlight');
      } else {
        el.classList.remove('highlight');
      }
    });
  };

  const getScreenRect = (): DOMRect | null =>
    root.hidden ? null : root.getBoundingClientRect();

  return {
    show,
    hide,
    isOpen: () => !root.hidden,
    setHighlight,
    getScreenRect,
  };
}
