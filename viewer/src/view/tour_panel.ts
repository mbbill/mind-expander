// Floating, draggable, corner+edge-resizable side panel that lists
// every step of the active tour. Click a row → jump the player to
// that step (same code path Next/Prev use); the bubble re-anchors
// automatically. The current step is highlighted via a purple
// left-edge bar — same color the code-panel focus indicator uses,
// for visual continuity.
//
// The panel is purely a view of player state. Toggling it (via the
// `t` key) does NOT stop the tour or mutate the diagram. The
// bubble and the diagram-side selection are owned by the player.

import type { ResolvedTour } from '../data/tour_schema.ts';

export interface TourPanelOptions {
  /** Click on a step row. Caller wires this to `tourPlayer.gotoStep`. */
  readonly onPickStep: (index: number) => void;
  /** Selecting another tour from the title-dropdown. Caller wires
   *  this to `tourPlayer.start(tour)`. */
  readonly onPickTour: (tour: ResolvedTour) => void;
  /** Fires every time the panel becomes visible or hidden — via
   *  the `t` key, the corner X button, the "new tour" pill, or
   *  any other call to `toggle()` / `open()`. Caller uses this to
   *  light up the `T tour` chip in the shortcut list. */
  readonly onToggle?: (open: boolean) => void;
}

export interface TourPanel {
  /** Show or hide the panel. Pure UI op — no player side-effects. */
  toggle(): void;
  /** Open the panel if it isn't already. Used by the "new tour"
   *  button which always wants the panel visible after click. */
  open(): void;
  /** True when the panel is on screen. */
  isOpen(): boolean;
  /** The tour whose steps the body should list. `null` clears the
   *  body to a "no active tour" placeholder. */
  setActiveTour(tour: ResolvedTour | null): void;
  /** Highlight the row at this index as the current step. `-1`
   *  clears the highlight (e.g. when the tour stops). */
  setCurrentStep(index: number): void;
  /** Update the dropdown's list of received tours. */
  setReceivedTours(tours: readonly ResolvedTour[]): void;
  /** The tour currently shown in the panel body (may be displayed
   *  without playback — e.g. after a page refresh that replays
   *  tours but doesn't auto-start). The host uses this to decide
   *  whether a row-click should `gotoStep` (same tour playing) or
   *  `start(..., index)` (different tour, or nothing playing). */
  currentTour(): ResolvedTour | null;
}

interface PanelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const STORAGE_KEY = 'mind-expander.tour-panel.rect';
const MIN_W = 240;
const MIN_H = 200;
const DEFAULT_RECT: PanelRect = {
  // Set on first open from window dimensions, so the values here
  // are just fallbacks for environments where window is too small.
  left: 0,
  top: 80,
  width: 340,
  height: 480,
};

export function createTourPanel(opts: TourPanelOptions): TourPanel {
  const root = document.createElement('div');
  root.className = 'tour-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Tour steps');

  // ── Header ───────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'tour-panel-header';
  // Title acts as both the displayed tour name AND the trigger for
  // the dropdown of all received tours. Clicking it toggles the
  // menu; outside click dismisses (same pattern as the old tour
  // bar's dropdown, see `tour_bar.ts:74-77` for the lineage).
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'tour-panel-title';
  title.title = 'Click to choose a tour';
  header.appendChild(title);
  // Right-aligned close button. Hiding the panel doesn't stop the
  // tour — it's a pure view toggle, same as pressing `t`.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tour-panel-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Hide panel (does not stop the tour)';
  closeBtn.setAttribute('aria-label', 'Hide tour panel');
  header.appendChild(closeBtn);
  root.appendChild(header);

  // ── Body ─────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'tour-panel-body';
  root.appendChild(body);

  // ── Resize handles (4 edges + 4 corners) ─────────────────────────
  // Each handle is a thin div positioned absolutely on its
  // respective edge. Pointer events flow through the otherwise
  // transparent overlay; resize logic mutates the panel rect.
  const handles: Array<{ dir: string; el: HTMLDivElement }> = [];
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const h = document.createElement('div');
    h.className = `tour-panel-resize tour-panel-resize-${dir}`;
    root.appendChild(h);
    handles.push({ dir, el: h });
  }

  document.body.appendChild(root);

  // ── State ────────────────────────────────────────────────────────
  let rect: PanelRect = loadRect();
  let activeTour: ResolvedTour | null = null;
  let currentStep = -1;
  let receivedTours: readonly ResolvedTour[] = [];
  let menu: HTMLDivElement | null = null;

  // ── Rect persistence ─────────────────────────────────────────────
  function loadRect(): PanelRect {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<PanelRect>;
        if (
          typeof parsed.left === 'number' &&
          typeof parsed.top === 'number' &&
          typeof parsed.width === 'number' &&
          typeof parsed.height === 'number'
        ) {
          return clampRect(parsed as PanelRect);
        }
      }
    } catch {
      // Fall through to default on any parse/IO error.
    }
    // Default: dock to the right edge with some breathing room.
    return clampRect({
      ...DEFAULT_RECT,
      left: Math.max(0, window.innerWidth - DEFAULT_RECT.width - 20),
    });
  }
  function saveRect(): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rect));
    } catch {
      // Storage may be unavailable in some embeds; non-fatal.
    }
  }
  function clampRect(r: PanelRect): PanelRect {
    const w = Math.max(MIN_W, Math.min(r.width, window.innerWidth));
    const h = Math.max(MIN_H, Math.min(r.height, window.innerHeight));
    const left = Math.max(0, Math.min(r.left, window.innerWidth - w));
    const top = Math.max(0, Math.min(r.top, window.innerHeight - h));
    return { left, top, width: w, height: h };
  }
  function applyRect(): void {
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
  }
  applyRect();

  // ── Drag-to-move (header) ────────────────────────────────────────
  // Only the title bar starts a drag; clicks on the title button
  // itself open the dropdown rather than starting a drag (we filter
  // by event.target). Same setPointerCapture pattern the bubble
  // uses (tour_bubble.ts:121-151).
  let drag: { dx: number; dy: number; pointerId: number } | null = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Don't start a drag from the title (dropdown trigger) or the
    // close button (panel-toggle). The header still has plenty of
    // empty area between them to start a drag from.
    if (e.target === title || e.target === closeBtn) return;
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pointerId: e.pointerId };
    header.setPointerCapture(e.pointerId);
    header.classList.add('is-dragging');
  });
  header.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    rect = clampRect({ ...rect, left: e.clientX - drag.dx, top: e.clientY - drag.dy });
    applyRect();
  });
  header.addEventListener('pointerup', (e) => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    header.releasePointerCapture(drag.pointerId);
    drag = null;
    header.classList.remove('is-dragging');
    saveRect();
  });

  // ── Resize handles ───────────────────────────────────────────────
  for (const { dir, el } of handles) {
    let rz: { startX: number; startY: number; start: PanelRect; pointerId: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      rz = { startX: e.clientX, startY: e.clientY, start: { ...rect }, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (rz === null || e.pointerId !== rz.pointerId) return;
      const dx = e.clientX - rz.startX;
      const dy = e.clientY - rz.startY;
      let { left, top, width, height } = rz.start;
      // Each handle direction mutates a subset of the four rect
      // edges. The n/w handles move the origin (left/top) AND
      // change size in the opposite direction, so the far edge
      // stays put visually as the user drags the near edge.
      if (dir.includes('e')) width = rz.start.width + dx;
      if (dir.includes('s')) height = rz.start.height + dy;
      if (dir.includes('w')) {
        width = rz.start.width - dx;
        left = rz.start.left + dx;
      }
      if (dir.includes('n')) {
        height = rz.start.height - dy;
        top = rz.start.top + dy;
      }
      rect = clampRect({ left, top, width, height });
      applyRect();
    });
    el.addEventListener('pointerup', (e) => {
      if (rz === null || e.pointerId !== rz.pointerId) return;
      el.releasePointerCapture(rz.pointerId);
      rz = null;
      saveRect();
    });
  }

  // ── Title / dropdown ─────────────────────────────────────────────
  function renderTitle(): void {
    if (activeTour === null) {
      title.textContent = '(no active tour)';
      title.classList.add('is-empty');
    } else {
      title.textContent = `${activeTour.title ?? '(no title)'} ▾`;
      title.classList.remove('is-empty');
    }
  }
  function closeMenu(): void {
    if (menu !== null) {
      menu.remove();
      menu = null;
      document.removeEventListener('mousedown', onDocDown, true);
    }
  }
  function onDocDown(e: MouseEvent): void {
    if (menu === null) return;
    if (menu.contains(e.target as Node)) return;
    if (title.contains(e.target as Node)) return;
    closeMenu();
  }
  function openMenu(): void {
    closeMenu();
    if (receivedTours.length === 0) return;
    menu = document.createElement('div');
    menu.className = 'tour-panel-menu';
    for (const t of receivedTours) {
      const row = document.createElement('div');
      row.className = 'tour-panel-menu-row';
      if (t.tour_id === activeTour?.tour_id) row.classList.add('is-active');
      row.textContent = `${t.title ?? '(no title)'} · ${t.tour_id}`;
      row.addEventListener('click', () => {
        closeMenu();
        opts.onPickTour(t);
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const r = title.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.addEventListener('mousedown', onDocDown, true);
  }
  title.addEventListener('click', () => {
    if (menu !== null) closeMenu();
    else openMenu();
  });

  // ── Body — list of steps ─────────────────────────────────────────
  /** Strip markdown emphasis / code / heading marks so the row text
   *  reads cleanly under the line-clamp. Full markdown still
   *  renders in the bubble at step-jump time. */
  function plainText(md: string): string {
    return md
      // Block headers (── Phase 1 ──) keep their content; the dashes
      // are part of the user's intentional decoration.
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
  }
  function renderBody(): void {
    body.replaceChildren();
    if (activeTour === null) {
      const empty = document.createElement('div');
      empty.className = 'tour-panel-empty';
      empty.textContent = 'No tour active. Receive a tour to populate this list.';
      body.appendChild(empty);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tour-panel-steps';
    activeTour.steps.forEach((step, idx) => {
      const li = document.createElement('li');
      li.className = 'tour-panel-step';
      if (idx === currentStep) li.classList.add('is-current');
      li.dataset.index = String(idx);
      const num = document.createElement('span');
      num.className = 'tour-panel-step-num';
      num.textContent = String(idx + 1);
      const text = document.createElement('div');
      text.className = 'tour-panel-step-text';
      text.textContent = plainText(step.say);
      li.appendChild(num);
      li.appendChild(text);
      li.addEventListener('click', () => {
        opts.onPickStep(idx);
      });
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  /** Reposition the scroll so the current row is visible. Avoids
   *  re-scrolling when the row is already on screen, otherwise
   *  centers it. */
  function scrollCurrentIntoView(): void {
    if (currentStep < 0) return;
    const row = body.querySelector<HTMLElement>(
      `.tour-panel-step[data-index="${currentStep}"]`,
    );
    if (row === null) return;
    const bRect = body.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    if (rRect.top < bRect.top || rRect.bottom > bRect.bottom) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Public API ───────────────────────────────────────────────────
  const isOpen = (): boolean => !root.hidden;
  const setOpen = (next: boolean): void => {
    if (next === isOpen()) return;
    if (next) {
      root.hidden = false;
      // Re-clamp in case the window was resized while the panel
      // was hidden.
      rect = clampRect(rect);
      applyRect();
    } else {
      root.hidden = true;
      closeMenu();
    }
    opts.onToggle?.(next);
  };
  const open = (): void => setOpen(true);
  const toggle = (): void => setOpen(!isOpen());
  // X button hides the panel without stopping the tour — same
  // semantics as pressing `t` while the panel is open.
  closeBtn.addEventListener('click', () => setOpen(false));
  const setActiveTour = (tour: ResolvedTour | null): void => {
    activeTour = tour;
    renderTitle();
    renderBody();
  };
  const setCurrentStep = (index: number): void => {
    if (index === currentStep) return;
    currentStep = index;
    // Update the highlight without a full body re-render — much
    // smoother for tours with many steps. Falls back to re-render
    // if the DOM somehow drifted out of sync.
    const rows = body.querySelectorAll<HTMLElement>('.tour-panel-step');
    if (rows.length === 0) return;
    rows.forEach((row) => {
      const idx = Number(row.dataset.index);
      row.classList.toggle('is-current', idx === currentStep);
    });
    if (isOpen()) scrollCurrentIntoView();
  };
  const setReceivedTours = (tours: readonly ResolvedTour[]): void => {
    receivedTours = tours;
    // Auto-display the most recent tour when nothing is currently
    // shown — typically the first page load after a refresh, where
    // `/api/tours` replays one or more tours but no playback is
    // active. Without this the user opens the panel with `t` and
    // sees a blank "(no active tour)" body even though a tour is
    // sitting right there in the dropdown.
    if (activeTour === null && tours.length > 0) {
      const latest = tours[tours.length - 1];
      if (latest !== undefined) setActiveTour(latest);
    }
    // Re-open the menu fresh if it was already open, so the new
    // tour appears immediately rather than waiting for the user
    // to close and re-open it.
    if (menu !== null) openMenu();
  };
  const currentTour = (): ResolvedTour | null => activeTour;

  // Reflow / re-clamp on window resize so the panel doesn't slip
  // off-screen when the browser shrinks.
  window.addEventListener('resize', () => {
    rect = clampRect(rect);
    applyRect();
  });

  return { toggle, open, isOpen, setActiveTour, setCurrentStep, setReceivedTours, currentTour };
}
