// Cascading hover menu anchored to the sticky-crate indicator. Hover
// the sticky to open a list of the crate's direct submodules; hover
// any row with children to open its submenu to the right (Windows
// menu-bar style); click any row to expand the chosen module + its
// ancestors, redraw, and pan the viewport so the module's row is
// visible.
//
// Modules only -- types aren't included. The menu is purely a
// navigation/expansion affordance, so leaf types (which can't expand)
// don't belong here.
//
// Lifetime model: one instance per `createCrateMenu()`. The host calls
// `setItems(crateName, items)` whenever the sticky's current crate
// changes; passing `null` unbinds and hides the menu. The menu owns
// its own DOM, hover state, and grace-delay timers.

export interface CrateMenuItem {
  /** Module id (e.g. `sf-nano-core::vm::store`). Passed back to the
   *  host's onPick callback when this row is clicked. */
  readonly id: string;
  /** Leaf label displayed in the row (e.g. `store`). The full path
   *  isn't shown -- the visual breadcrumb is "you got here from the
   *  parent panel," not text. */
  readonly label: string;
  /** Direct submodule children. Empty array = leaf row (no right
   *  submenu, no `▶` glyph). */
  readonly children: readonly CrateMenuItem[];
}

export interface CrateMenu {
  /** Bind the menu to a sticky crate. Pass `null` to hide and detach.
   *  Called by the host whenever the sticky's current crate changes
   *  (including initial bind and crate-switch on scroll). */
  readonly setItems: (crateName: string | null, items: readonly CrateMenuItem[]) => void;
}

interface OpenPanel {
  readonly el: HTMLElement;
  readonly items: readonly CrateMenuItem[];
  /** Index of the row currently showing its submenu (-1 = none). */
  hoveredIndex: number;
}

const OPEN_DELAY_MS = 100;
const CLOSE_DELAY_MS = 200;
// Zero gap on purpose: any visible space between adjacent panels is
// a dead zone the cursor falls into, which fires mouseleave on the
// open chain and closes everything. With the panels flush, the
// cursor sweeps smoothly across the seam without losing hover.
const PANEL_GAP = 0;

export function createCrateMenu(opts: {
  /** The anchor element (the #sticky-crate div). Menu is positioned
   *  relative to its bounding rect on the page. */
  readonly anchorEl: HTMLElement;
  /** Click on a menu row -> host expands + pans to the picked module. */
  readonly onPick: (moduleId: string) => void;
}): CrateMenu {
  let bound = false;
  let currentItems: readonly CrateMenuItem[] = [];
  const openPanels: OpenPanel[] = [];
  let openTimer: number | null = null;
  let closeTimer: number | null = null;

  const root = document.createElement('div');
  root.className = 'crate-menu-root';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '15';
  root.style.display = 'none';
  document.body.appendChild(root);

  const clearOpenTimer = (): void => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };
  const clearCloseTimer = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const closeAll = (): void => {
    clearOpenTimer();
    clearCloseTimer();
    for (const p of openPanels) p.el.remove();
    openPanels.length = 0;
    root.style.display = 'none';
  };

  // Close panels deeper than `keepDepth`. Used when the cursor moves
  // between rows in a panel: the previously-open submenu chain past
  // this depth gets torn down before a new submenu opens.
  const trimDepth = (keepDepth: number): void => {
    while (openPanels.length > keepDepth) {
      const panel = openPanels.pop();
      if (panel !== undefined) panel.el.remove();
    }
  };

  // Create a panel DOM element for one menu level. `anchorRect` is the
  // bounding rect of whatever opens the panel: the sticky element for
  // the top panel, or the hovered row for a submenu. The panel sits
  // to the RIGHT of the anchor, vertically aligned to its top.
  const openPanelAt = (
    items: readonly CrateMenuItem[],
    anchorRect: DOMRect,
    depth: number,
  ): void => {
    const el = document.createElement('div');
    el.className = 'crate-menu-panel';
    el.style.pointerEvents = 'auto';
    el.style.position = 'absolute';
    // Mouse leaving the panel chain hides after a grace delay; entering
    // it cancels any pending hide. The grace is what lets the cursor
    // sweep diagonally to a deeper submenu without losing the open
    // chain.
    el.addEventListener('mouseenter', clearCloseTimer);
    el.addEventListener('mouseleave', () => scheduleClose());

    const panel: OpenPanel = { el, items, hoveredIndex: -1 };

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'crate-menu-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.className = 'crate-menu-row-label';
      label.textContent = item.label;
      row.appendChild(label);
      if (item.children.length > 0) {
        const caret = document.createElement('span');
        caret.className = 'crate-menu-row-caret';
        caret.textContent = '▶';
        row.appendChild(caret);
      }
      row.addEventListener('mouseenter', () => {
        if (panel.hoveredIndex === index) return;
        panel.hoveredIndex = index;
        // Drop any deeper open submenus before opening the new one.
        trimDepth(depth + 1);
        // Visual highlight on hovered row -- clear from previous row.
        panel.el.querySelectorAll('.crate-menu-row.hover').forEach((n) => {
          n.classList.remove('hover');
        });
        row.classList.add('hover');
        if (item.children.length > 0) {
          openPanelAt(item.children, row.getBoundingClientRect(), depth + 1);
        }
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onPick(item.id);
        closeAll();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          opts.onPick(item.id);
          closeAll();
        }
      });
      el.appendChild(row);
    });

    root.appendChild(el);
    // Measure now that the panel is in the DOM, then place it.
    //
    // Top panel (depth 0) drops DOWN from the sticky-crate anchor,
    // aligned to its left edge -- the menu reads as "what's inside
    // this crate" hanging off the label. Deeper panels fan to the
    // RIGHT of the hovered row, top-aligned, like an OS menu bar.
    // Clamp into the viewport on both axes; on overflow, fall back
    // to the opposite side of the anchor.
    const rect = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (depth === 0) {
      left = anchorRect.left;
      if (left + rect.width > window.innerWidth - PANEL_GAP) {
        left = Math.max(PANEL_GAP, window.innerWidth - rect.width - PANEL_GAP);
      }
      top = anchorRect.bottom + PANEL_GAP;
      if (top + rect.height > window.innerHeight - PANEL_GAP) {
        top = Math.max(PANEL_GAP, anchorRect.top - rect.height - PANEL_GAP);
      }
    } else {
      left = anchorRect.right + PANEL_GAP;
      if (left + rect.width > window.innerWidth - PANEL_GAP) {
        left = Math.max(PANEL_GAP, anchorRect.left - rect.width - PANEL_GAP);
      }
      top = anchorRect.top;
      if (top + rect.height > window.innerHeight - PANEL_GAP) {
        top = Math.max(PANEL_GAP, window.innerHeight - rect.height - PANEL_GAP);
      }
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    openPanels.push(panel);
    root.style.display = 'block';
  };

  const scheduleOpen = (): void => {
    clearCloseTimer();
    if (openPanels.length > 0) return;
    if (currentItems.length === 0) return;
    clearOpenTimer();
    openTimer = window.setTimeout(() => {
      openTimer = null;
      const anchorRect = opts.anchorEl.getBoundingClientRect();
      openPanelAt(currentItems, anchorRect, 0);
    }, OPEN_DELAY_MS);
  };

  const scheduleClose = (): void => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      closeAll();
    }, CLOSE_DELAY_MS);
  };

  // Attach/detach hover handlers on the anchor.
  const onAnchorEnter = (): void => scheduleOpen();
  const onAnchorLeave = (): void => scheduleClose();

  const bind = (): void => {
    if (bound) return;
    opts.anchorEl.addEventListener('mouseenter', onAnchorEnter);
    opts.anchorEl.addEventListener('mouseleave', onAnchorLeave);
    bound = true;
  };
  const unbind = (): void => {
    if (!bound) return;
    opts.anchorEl.removeEventListener('mouseenter', onAnchorEnter);
    opts.anchorEl.removeEventListener('mouseleave', onAnchorLeave);
    bound = false;
  };

  // ESC closes the menu chain immediately, no grace.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPanels.length > 0) closeAll();
  });

  // A canvas click outside the menu chain also closes it. Capture
  // phase so canvas clicks hidden behind the pointer-transparent root
  // still fire.
  document.addEventListener(
    'click',
    (e) => {
      if (openPanels.length === 0) return;
      const target = e.target;
      if (target instanceof Node) {
        for (const p of openPanels) {
          if (p.el.contains(target)) return;
        }
        if (opts.anchorEl.contains(target)) return;
      }
      closeAll();
    },
    true,
  );

  return {
    setItems: (crateName, items) => {
      currentItems = items;
      if (crateName === null || items.length === 0) {
        unbind();
        closeAll();
      } else {
        bind();
      }
    },
  };
}
