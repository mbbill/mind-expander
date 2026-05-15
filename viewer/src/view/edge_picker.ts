// Floating picker for revealing/hiding individual edges in a fan.
//
// Generic over what an "edge" means -- the host populates entries and
// decides what onPick/onShowAll/onHideAll do. Used today for two
// surfaces:
//   - Call edges: clicking a callable row's `→` glyph (outgoing) or
//     incoming marker (incoming).
//   - Ownership edges: clicking a type's dot to reveal/hide arrows
//     from individual owners.
//
// Each entry renders as one row of plain label text; clicking it
// toggles that one edge's visibility via the host's onPick callback.
// Bold = currently revealed. A top-row toolbar exposes bulk
// show all / hide all actions wired to the host the same way.
//
// Visually: a rounded white panel with a thin border and soft shadow,
// styled in index.html under `.edge-picker-panel`. The panel positions
// to the side of the trigger so the cursor doesn't have to cross other
// rows to land on a target -- and direction is sticky (incoming always
// fans left, outgoing always fans right) so the picker doesn't
// visually contradict the marker that opened it.
//
// Lives in screen-space (fixed-position), like arrow_disambig. Outside
// click dismisses; ESC dismisses; picking a row dismisses too.

export type EdgeDirection = 'outgoing' | 'incoming';

export interface EdgeEntry {
  /** Full path of the OTHER endpoint of the edge -- callee for an
   *  outgoing call, caller for an incoming call, owner type for an
   *  ownership entry. Used as the row's identity AND as the key the
   *  host needs to flip visibility on. */
  readonly otherFullPath: string;
  /** Display path for the row label -- usually the qualified type path
   *  for the row's container, joined with the member name. */
  readonly label: string;
  /** Optional dimmed module-path prefix portion of the label, with the
   *  crate name already removed (e.g., `vm::store::`). The crate name,
   *  if shown, lives in `crateName` so it can be styled distinctly. */
  readonly prefix?: string;
  /** Crate name to show in the cross-crate accent color (purple). Set
   *  only when this entry's crate differs from the anchor row's crate
   *  -- same-crate entries omit this so the prefix reads as a bare
   *  module path. */
  readonly crateName?: string;
  /** True when this edge is currently visible. The renderer bolds the
   *  row so the user sees current state at the moment the picker
   *  opens. */
  readonly active: boolean;
}

export interface EdgePickerShowArgs {
  readonly entries: readonly EdgeEntry[];
  /** Screen-space anchor -- usually the cursor position at click time. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Fan direction. 'outgoing' fans the entries to the RIGHT of the
   *  anchor (e.g. callees flow right from the source row); 'incoming'
   *  fans LEFT (e.g. callers and owners flow leftward toward the
   *  target row). */
  readonly direction: EdgeDirection;
  /** Picked: the entry the user clicked. Caller toggles its edge. */
  readonly onPick: (entry: EdgeEntry) => void;
  /** Bulk: reveal every entry's edge at once. Bound to the panel's
   *  "show all" toolbar button. The host decides what "show" means
   *  (typically: set the visibility key for every entry that isn't
   *  already active). */
  readonly onShowAll: () => void;
  /** Bulk: hide every entry's edge. Symmetric with `onShowAll`. */
  readonly onHideAll: () => void;
}

export interface EdgePicker {
  show: (args: EdgePickerShowArgs) => void;
  hide: () => void;
  /** Shift the panel by the canvas pan delta. Called by the viewport
   *  pan/zoom hook so the picker stays anchored to the data point
   *  beneath it as the user drags. Zoom changes hide() the picker
   *  instead (no clean reanchor after a scale change). */
  moveBy: (dx: number, dy: number) => void;
}

import { forwardWheelToCanvas } from './wheel_forward.ts';

const MARGIN = 8;
const ENTRY_GAP = 2;

export function createEdgePicker(): EdgePicker {
  const root = document.createElement('div');
  root.id = 'edge-picker';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '24';
  root.style.display = 'none';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'edge-picker-panel';
  panel.style.pointerEvents = 'auto';
  // Wheel events on the panel forward to the canvas so the user can
  // still pan/zoom the diagram while the picker is open.
  forwardWheelToCanvas(panel);
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

  const show = (args: EdgePickerShowArgs): void => {
    panel.replaceChildren();
    // Top-row toolbar with bulk "show all" / "hide all" buttons. The
    // host wires these to flip every entry's visibility in one click,
    // bypassing the row-by-row toggle when the user just wants the
    // whole fan revealed or hidden. Buttons stay clickable even when
    // they would be no-ops -- the idempotent action is cheap and
    // disabling-then-re-enabling churns the DOM on state changes.
    const toolbar = document.createElement('div');
    toolbar.className = 'edge-picker-toolbar';
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'edge-picker-btn';
    showAllBtn.textContent = 'show all';
    showAllBtn.addEventListener('click', () => {
      args.onShowAll();
      hide();
    });
    const hideAllBtn = document.createElement('button');
    hideAllBtn.type = 'button';
    hideAllBtn.className = 'edge-picker-btn';
    hideAllBtn.textContent = 'hide all';
    hideAllBtn.addEventListener('click', () => {
      args.onHideAll();
      hide();
    });
    toolbar.appendChild(showAllBtn);
    toolbar.appendChild(hideAllBtn);
    panel.appendChild(toolbar);

    for (const entry of args.entries) {
      const row = document.createElement('div');
      row.className = 'edge-picker-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (entry.active) row.classList.add('active');

      if (entry.crateName !== undefined && entry.crateName !== '') {
        // Cross-crate entries lead with the crate name in purple so the
        // boundary is the first thing the eye registers. Trailing `::`
        // belongs to the crate span -- it reads as part of the crate
        // segment rather than as a generic path separator.
        const crate = document.createElement('span');
        crate.className = 'edge-picker-crate';
        crate.textContent = `${entry.crateName}::`;
        row.appendChild(crate);
      }
      if (entry.prefix !== undefined && entry.prefix !== '') {
        const prefix = document.createElement('span');
        prefix.className = 'edge-picker-prefix';
        prefix.textContent = entry.prefix;
        row.appendChild(prefix);
      }
      const main = document.createElement('span');
      main.className = 'edge-picker-main';
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
    // the cursor doesn't sit on top of the first row's text -- a
    // smaller gap made the picker feel like it overlapped the click
    // target.
    const ANCHOR_GAP = 18;
    let left: number;
    if (args.direction === 'outgoing') {
      // Anchor on the left edge of the panel. If the panel runs off the
      // right edge of the viewport, clamp to the right margin rather
      // than flipping to the cursor's left -- direction is meaningful
      // (outgoing fans right) and flipping confuses the user.
      left = args.anchorX + ANCHOR_GAP;
      if (left + rect.width > window.innerWidth - MARGIN) {
        left = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
      }
    } else {
      // Anchor on the right edge of the panel -- entries grow leftward
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
    // Intentionally NOT auto-focusing the first row -- the user clicks
    // or arrows to a target, and a pre-highlighted row reads as
    // "already selected" which the picker doesn't actually represent.
  };

  return { show, hide, moveBy };
}
