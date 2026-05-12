// Hover-triggered popover that lists incoming ownership relationships
// for a hovered type. Lives outside the SVG zoom layer so it doesn't
// scale with zoom; positioned in screen-space using the dot's current
// screen coordinates derived from the active zoom transform.
//
// Hover semantics: 300ms grace on dot mouse-leave so the cursor can
// travel to the panel; the panel itself cancels the hide on enter and
// re-arms on leave.

const PANEL_OFFSET_X = 18; // gap between dot and panel
const HIDE_DELAY_MS = 300;

export interface OwnerEntry {
  readonly modulePath: string;
  readonly typeLabel: string;
  readonly typeId: string;
  /** Crate name to display BEFORE the module path. Set only when the
   *  owner lives in a different crate from the hovered type — same-crate
   *  owners pass `undefined` so the crate name stays out of the way.
   *  main.ts owns the cross-crate decision so the rule matches the
   *  call-target picker and arrow disambig. */
  readonly crateName?: string;
}

export interface ShowArgs {
  readonly owners: ReadonlyArray<OwnerEntry>;
  /** Callback that returns the dot's current screen-space center. Captures
   *  the SVG circle element so the overlay can re-project on every zoom
   *  event when pinned, keeping the panel anchored to the moving dot. */
  readonly getDotScreenPos: () => { x: number; y: number };
  /** Toggle expansion of every owner type. Returns the new state — true
   *  if owners are now expanded, false if they were already expanded and
   *  got folded. The popover uses this to flip the button's tooltip and
   *  active styling. */
  readonly onToggleExpandAll: () => boolean;
  /** Whether all owners are currently expanded. Drives the button's
   *  initial visual state and tooltip on `show()`. */
  readonly initiallyAllExpanded: boolean;
}

export interface OwnersOverlay {
  show: (args: ShowArgs) => void;
  /** Schedule a delayed hide. No-op while pinned. Cancelled by panel hover. */
  hide: () => void;
  /** Hide right away — overrides the pinned state. Used by full reset
   *  flows (resetAll) and when a row navigation completes. */
  hideImmediately: () => void;
  /** Called by the zoom layer on every pan/zoom event. Behavior:
   *  - if not visible → no-op;
   *  - if not pinned → dismiss (the dot the popover points to has moved);
   *  - if pinned → re-project the dot's current screen position via the
   *    saved getDotScreenPos closure and reposition the panel so it stays
   *    anchored to the dot as the canvas moves under it. */
  onCanvasMoved: () => void;
}

export function createOwnersOverlay(opts: {
  onNavigate: (typeId: string) => void;
}): OwnersOverlay {
  // Root container: covers the viewport, transparent to clicks except where
  // a child element re-enables pointer events (the panel).
  const root = document.createElement('div');
  root.id = 'owners-overlay';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '20';
  root.style.display = 'none';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'owners-panel';
  panel.style.pointerEvents = 'auto';
  panel.style.position = 'absolute';
  root.appendChild(panel);

  let hideTimer: number | null = null;
  let pinned = false;
  let getDotScreenPos: (() => { x: number; y: number }) | null = null;

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const scheduleHide = (): void => {
    if (pinned) return; // Pinned panels never auto-dismiss.
    cancelHide();
    hideTimer = window.setTimeout(() => {
      root.style.display = 'none';
      hideTimer = null;
    }, HIDE_DELAY_MS);
  };

  panel.addEventListener('mouseenter', cancelHide);
  panel.addEventListener('mouseleave', scheduleHide);

  // Position the panel near a given dot screen-position. Used both on the
  // initial show and on each repositionPinned call when the canvas moves.
  const placePanel = (dotScreenX: number, dotScreenY: number): void => {
    const rect = panel.getBoundingClientRect();
    const panelW = rect.width;
    const panelH = rect.height;
    let panelLeft = dotScreenX - PANEL_OFFSET_X - panelW;
    if (panelLeft < 8) panelLeft = dotScreenX + PANEL_OFFSET_X;
    let panelTop = dotScreenY - panelH / 2;
    panelTop = Math.max(8, Math.min(panelTop, window.innerHeight - panelH - 8));
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;
  };

  const show = (args: ShowArgs): void => {
    cancelHide();
    getDotScreenPos = args.getDotScreenPos;

    panel.innerHTML = '';

    // Reset pin state on every fresh show; pinning is per-popup-instance.
    pinned = false;

    const header = document.createElement('div');
    header.className = 'header';
    const title = document.createElement('div');
    title.className = 'title';
    const totalOwners = args.owners.length;
    title.textContent = `Owners (${totalOwners})`;
    header.appendChild(title);

    // Buttons cluster together on the right edge — wrap them in their own
    // tight-gap flex group so they sit close while the title can spread
    // away on the left via header's space-between.
    const actions = document.createElement('div');
    actions.className = 'header-actions';

    const expandBtn = document.createElement('button');
    expandBtn.className = 'expand-all-btn';
    expandBtn.type = 'button';
    expandBtn.title = args.initiallyAllExpanded ? 'Fold all owners' : 'Expand all owners';
    expandBtn.classList.toggle('active', args.initiallyAllExpanded);
    expandBtn.textContent = '⇇';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowExpanded = args.onToggleExpandAll();
      expandBtn.classList.toggle('active', nowExpanded);
      expandBtn.title = nowExpanded ? 'Fold all owners' : 'Expand all owners';
      // No popover-position tracking needed — `onToggleExpandAll` itself
      // anchors the hovered type's screen position so the dot stays put.
    });
    actions.appendChild(expandBtn);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn';
    pinBtn.type = 'button';
    pinBtn.title = 'Pin';
    pinBtn.textContent = '📌';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinned = !pinned;
      pinBtn.classList.toggle('active', pinned);
      pinBtn.title = pinned ? 'Unpin (allows auto-dismiss)' : 'Pin (prevents auto-dismiss)';
      // Unpinning while the cursor is outside the panel should immediately
      // arm the dismiss timer; if cursor is inside the panel, scheduleHide
      // is a no-op because mouseleave hasn't fired.
      if (!pinned) scheduleHide();
      else cancelHide();
    });
    actions.appendChild(pinBtn);
    header.appendChild(actions);
    panel.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'owners-list';
    // One row per owner — keeps the visible count matching the title's
    // count. Multiple owners in the same module repeat the module path,
    // which is fine; the panel scrolls if it overflows max-height.
    for (const o of args.owners) {
      const li = document.createElement('li');
      li.className = 'owners-row';
      // The row is a flex column (path on top, type label on bottom),
      // so the entire path lives in ONE `.module` span. Cross-crate
      // owners insert a nested `.crate` span that the stylesheet paints
      // in the accent color — same purple as the call-target picker
      // and the arrow disambig. Same-crate owners read as a bare module
      // path; the `(crate root)` placeholder appears only when there is
      // also no crate prefix to anchor the line.
      const m = document.createElement('span');
      m.className = 'module';
      const hasCrate = o.crateName !== undefined && o.crateName !== '';
      if (hasCrate) {
        const c = document.createElement('span');
        c.className = 'crate';
        c.textContent = o.modulePath === '' ? (o.crateName as string) : `${o.crateName as string}::`;
        m.appendChild(c);
      }
      if (o.modulePath !== '') {
        m.appendChild(document.createTextNode(o.modulePath));
      } else if (!hasCrate) {
        m.appendChild(document.createTextNode('(crate root)'));
      }
      li.appendChild(m);
      const t = document.createElement('span');
      t.className = 'types';
      t.textContent = o.typeLabel;
      li.appendChild(t);
      li.addEventListener('click', () => {
        opts.onNavigate(o.typeId);
        cancelHide();
        pinned = false;
        root.style.display = 'none';
      });
      list.appendChild(li);
    }
    panel.appendChild(list);

    // Reveal so we can measure the panel's actual size.
    root.style.display = 'block';
    const pos = args.getDotScreenPos();
    placePanel(pos.x, pos.y);
  };

  return {
    show,
    hide: scheduleHide,
    hideImmediately: () => {
      cancelHide();
      pinned = false;
      getDotScreenPos = null;
      root.style.display = 'none';
    },
    onCanvasMoved: () => {
      if (root.style.display === 'none') return;
      if (!pinned) {
        cancelHide();
        getDotScreenPos = null;
        root.style.display = 'none';
        return;
      }
      // Pinned: re-anchor to the dot's new on-screen position.
      if (!getDotScreenPos) return;
      const pos = getDotScreenPos();
      placePanel(pos.x, pos.y);
    },
  };
}
