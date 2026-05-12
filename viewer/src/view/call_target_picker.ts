// Floating picker for revealing a single call edge.
//
// Triggered from a callable row's `→` glyph (outgoing — fans right) or
// its incoming `→` marker (incoming — fans left). Each entry is a row
// of plain label text; clicking it toggles just that arrow's
// visibility. Bold = currently revealed.
//
// Visually: a rounded white panel with a thin border and soft shadow,
// styled in index.html under `.call-target-picker-panel`. The panel
// positions to the side of the trigger so the cursor doesn't have to
// cross any other rows to land on a target — and direction is sticky
// (incoming always fans left, outgoing always fans right) so the
// picker doesn't visually contradict the marker that opened it.
//
// Lives in screen-space (fixed-position), like arrow_disambig. Outside
// click dismisses; ESC dismisses; picking a row dismisses too.

export type CallEdgeDirection = 'outgoing' | 'incoming';

export interface CallEdgeEntry {
  /** Full path of the callee (outgoing) or caller (incoming). Used as
   *  the picker row's identity AND as the half of the edge key the
   *  caller-side state machine needs to toggle. */
  readonly otherFullPath: string;
  /** Display path for the row label — usually the qualified type path
   *  for the row's container, joined with the function name and `()`. */
  readonly label: string;
  /** Optional dimmed module-path prefix portion of the label, with the
   *  crate name already removed (e.g., `vm::store::`). The crate name,
   *  if shown, lives in `crateName` so it can be styled distinctly. */
  readonly prefix?: string;
  /** Crate name to show in the cross-crate accent color (purple). Set
   *  only when this entry's crate differs from the anchor row's crate
   *  — same-crate entries omit this so the prefix reads as a bare
   *  module path. */
  readonly crateName?: string;
  /** True when this edge is currently visible. The renderer bolds the
   *  row so the user sees current state at the moment of the picker
   *  opening. */
  readonly active: boolean;
}

export interface CallTargetPickerShowArgs {
  readonly entries: readonly CallEdgeEntry[];
  /** Screen-space anchor — usually the cursor position at click time. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Fan direction. 'outgoing' fans the entries to the RIGHT of the
   *  anchor (callees flow right from the source row); 'incoming' fans
   *  LEFT (callers flow leftward to the target row). */
  readonly direction: CallEdgeDirection;
  /** Picked: the entry the user clicked. Caller toggles its edge. */
  readonly onPick: (entry: CallEdgeEntry) => void;
}

export interface CallTargetPicker {
  show: (args: CallTargetPickerShowArgs) => void;
  hide: () => void;
  /** Shift the panel by the canvas pan delta. Called by the viewport
   *  pan/zoom hook so the picker stays anchored to the data point
   *  beneath it as the user drags. Zoom changes hide() the picker
   *  instead (no clean reanchor after a scale change). */
  moveBy: (dx: number, dy: number) => void;
}

const MARGIN = 8;
const ENTRY_GAP = 2;

export function createCallTargetPicker(): CallTargetPicker {
  const root = document.createElement('div');
  root.id = 'call-target-picker';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '24';
  root.style.display = 'none';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'call-target-picker-panel';
  panel.style.pointerEvents = 'auto';
  panel.style.position = 'absolute';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = `${ENTRY_GAP}px`;
  root.appendChild(panel);

  let panelLeft = 0;
  let panelTop = 0;

  const hide = (): void => {
    root.style.display = 'none';
  };

  const moveBy = (dx: number, dy: number): void => {
    if (root.style.display === 'none') return;
    panelLeft += dx;
    panelTop += dy;
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;
  };

  // A document-level click dismisses unless inside the panel. Capture
  // phase so canvas clicks that bubble through the pointer-transparent
  // root still hide the picker.
  document.addEventListener(
    'click',
    (e) => {
      if (root.style.display === 'none') return;
      if (e.button !== 0) return;
      const target = e.target;
      if (target instanceof Node && panel.contains(target)) return;
      hide();
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.style.display !== 'none') hide();
  });

  const show = (args: CallTargetPickerShowArgs): void => {
    panel.replaceChildren();
    for (const entry of args.entries) {
      const row = document.createElement('div');
      row.className = 'call-target-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (entry.active) row.classList.add('active');

      if (entry.crateName !== undefined && entry.crateName !== '') {
        // Cross-crate entries lead with the crate name in purple so the
        // boundary is the first thing the eye registers. Trailing `::`
        // belongs to the crate span — it reads as part of the crate
        // segment rather than as a generic path separator.
        const crate = document.createElement('span');
        crate.className = 'call-target-crate';
        crate.textContent = `${entry.crateName}::`;
        row.appendChild(crate);
      }
      if (entry.prefix !== undefined && entry.prefix !== '') {
        const prefix = document.createElement('span');
        prefix.className = 'call-target-prefix';
        prefix.textContent = entry.prefix;
        row.appendChild(prefix);
      }
      const main = document.createElement('span');
      main.className = 'call-target-main';
      main.textContent = entry.label;
      row.appendChild(main);

      const onActivate = (): void => {
        args.onPick(entry);
        hide();
      };
      row.addEventListener('click', onActivate);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      });
      panel.appendChild(row);
    }

    // Show first to measure, then position so the panel sits next to
    // the anchor on the chosen side and stays inside the viewport.
    panel.style.left = '0px';
    panel.style.top = '0px';
    root.style.display = 'block';
    const rect = panel.getBoundingClientRect();

    // Gap between the cursor and the picker. Pushed wide enough that
    // the cursor doesn't sit on top of the first row's text — a
    // smaller gap made the picker feel like it overlapped the click
    // target.
    const ANCHOR_GAP = 18;
    let left: number;
    if (args.direction === 'outgoing') {
      // Anchor on the left edge of the panel. If the panel runs off the
      // right edge of the viewport, clamp to the right margin rather
      // than flipping to the cursor's left — direction is meaningful
      // (outgoing fans right) and flipping confuses the user.
      left = args.anchorX + ANCHOR_GAP;
      if (left + rect.width > window.innerWidth - MARGIN) {
        left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
      }
    } else {
      // Anchor on the right edge of the panel — entries grow leftward
      // from the cursor. If that overflows the left edge, clamp to the
      // left margin rather than flipping to the cursor's right (an
      // incoming picker that appears on the right reads as outgoing).
      left = args.anchorX - rect.width - ANCHOR_GAP;
      if (left < MARGIN) {
        left = MARGIN;
      }
    }
    // Center vertically on the anchor; clamp into viewport.
    let top = args.anchorY - rect.height / 2;
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    }
    if (top < MARGIN) top = MARGIN;
    panelLeft = left;
    panelTop = top;
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;
    // Intentionally NOT auto-focusing the first row — the user clicks
    // or arrows to a target, and a pre-highlighted row reads as
    // "already selected" which the picker doesn't actually represent.
  };

  return { show, hide, moveBy };
}
