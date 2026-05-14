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
}

export interface CodePanel {
  show: (args: CodePanelShowArgs) => void;
  hide: () => void;
  isOpen: () => boolean;
}

export function createCodePanel(opts: CodePanelOptions): CodePanel {
  const root = document.querySelector<HTMLElement>('#code-panel');
  if (!root) throw new Error('missing #code-panel root element');
  const titleEl = root.querySelector<HTMLElement>('.code-panel-title');
  const closeBtn = root.querySelector<HTMLButtonElement>('.code-panel-close');
  const bodyEl = root.querySelector<HTMLElement>('.code-panel-body');
  const headerEl = root.querySelector<HTMLElement>('.code-panel-header');
  const resizerEl = root.querySelector<HTMLElement>('.code-panel-resize');
  if (!titleEl || !closeBtn || !bodyEl || !headerEl || !resizerEl) {
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
    root.style.height = `${state.h}px`;
  };
  applyState();

  // Drag the header to move the panel.
  let drag: { readonly id: number; offX: number; offY: number } | null = null;
  headerEl.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.code-panel-close') !== null) return;
    drag = { id: e.pointerId, offX: e.clientX - state.x, offY: e.clientY - state.y };
    headerEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.id) return;
    state = { ...state, x: e.clientX - drag.offX, y: e.clientY - drag.offY };
    applyState();
  });
  const endDrag = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.id) return;
    if (headerEl.hasPointerCapture(e.pointerId)) headerEl.releasePointerCapture(e.pointerId);
    drag = null;
    saveState(state);
  };
  headerEl.addEventListener('pointerup', endDrag);
  headerEl.addEventListener('pointercancel', endDrag);

  // Resize from bottom-right corner.
  let resize: { readonly id: number; startW: number; startH: number; startX: number; startY: number } | null = null;
  resizerEl.addEventListener('pointerdown', (e) => {
    resize = {
      id: e.pointerId,
      startW: state.w,
      startH: state.h,
      startX: e.clientX,
      startY: e.clientY,
    };
    resizerEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  resizerEl.addEventListener('pointermove', (e) => {
    if (resize === null || e.pointerId !== resize.id) return;
    state = {
      ...state,
      w: resize.startW + (e.clientX - resize.startX),
      h: resize.startH + (e.clientY - resize.startY),
    };
    applyState();
  });
  const endResize = (e: PointerEvent): void => {
    if (resize === null || e.pointerId !== resize.id) return;
    if (resizerEl.hasPointerCapture(e.pointerId)) resizerEl.releasePointerCapture(e.pointerId);
    resize = null;
    saveState(state);
  };
  resizerEl.addEventListener('pointerup', endResize);
  resizerEl.addEventListener('pointercancel', endResize);

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
    // Plain-text rendering with line numbers. Each line is a <div>
    // tagged with data-line so click handling can recover the line.
    // Highlighted span (startLine..endLine inclusive) gets a class
    // for the CSS to paint a background.
    const lines = text.split('\n');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
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
      code.textContent = lines[i] ?? '';
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
    titleEl.textContent = args.file;
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
    inflight?.abort();
    inflight = null;
    root.hidden = true;
  };

  return {
    show,
    hide,
    isOpen: () => !root.hidden,
  };
}
