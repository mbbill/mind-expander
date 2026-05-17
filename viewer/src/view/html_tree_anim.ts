// FLIP animation for the module-tree column. Runs on the toggle path
// only (not on zoom/scroll redraws). Decoupled from `renderHtmlModuleTree`
// so the renderer stays a pure (layout, k) → DOM function.
//
// Strategy:
//   1. Snapshot every visible .module-group's viewport rect (keyed by
//      dataset.id) and clone the container into a detached ghost layer
//      BEFORE the toggle mutates state.
//   2. The caller mutates state and triggers the normal redraw, which
//      `replaceChildren()`s the live container.
//   3. After the next frame, FLIP each persisting group from its old
//      rect to its new one, fade-in any entering groups, and mount the
//      ghost as a sibling overlay so the now-missing (exiting) groups
//      fade out at their last visual position.

const DEFAULT_DURATION_MS = 140;
const GHOST_ATTR = 'data-tree-ghost';

export interface TreeSnapshot {
  readonly rects: ReadonlyMap<string, DOMRect>;
  readonly ghost: HTMLElement;
}

/** Capture rects + a detached deep clone of `container`. Removes any
 *  stale ghost left behind by a still-in-flight prior animation. */
export function snapshotTreeState(container: HTMLElement): TreeSnapshot {
  const parent = container.parentElement;
  if (parent !== null) {
    for (const old of Array.from(parent.querySelectorAll<HTMLElement>(`[${GHOST_ATTR}]`))) {
      old.remove();
    }
  }

  const rects = new Map<string, DOMRect>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('.module-group'))) {
    const id = el.dataset['id'];
    if (id === undefined || id === '') continue;
    rects.set(id, el.getBoundingClientRect());
  }

  const ghost = container.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.setAttribute(GHOST_ATTR, '1');
  // Cloned children inherit ids/data-attrs; that's fine — we use the
  // data-id to diff against the live tree, and there are no event
  // handlers on cloned nodes because cloneNode doesn't copy them.

  return { rects, ghost };
}

interface FlipOpts {
  readonly durationMs?: number;
}

/** Run the FLIP after the live `container` has been rebuilt. Mounts
 *  `snap.ghost` as a sibling overlay so disappearing rows fade out at
 *  their pre-toggle position. */
export function playTreeFlip(
  container: HTMLElement,
  snap: TreeSnapshot,
  opts: FlipOpts = {},
): void {
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
  const easing = 'ease-out';

  // Build the set of ids currently present in the rebuilt tree so we
  // can classify each old/new node as persisting / entering / exiting.
  const liveGroups = Array.from(
    container.querySelectorAll<HTMLElement>('.module-group'),
  );
  const newIds = new Set<string>();
  for (const el of liveGroups) {
    const id = el.dataset['id'];
    if (id !== undefined && id !== '') newIds.add(id);
  }

  // Persisting + entering: animate the LIVE nodes.
  for (const el of liveGroups) {
    const id = el.dataset['id'];
    if (id === undefined || id === '') continue;
    const oldRect = snap.rects.get(id);
    if (oldRect !== undefined) {
      const newRect = el.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration, easing, fill: 'none' },
      );
    } else {
      el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration, easing, fill: 'both' },
      );
    }
  }

  // Exiting: mount the ghost and fade out only the groups whose ids
  // no longer exist in the live tree. Hide the rest so the user
  // doesn't see doubled rows during the animation window.
  const parent = container.parentElement;
  if (parent === null) return;

  // Match the live container's positioning so the ghost overlays it
  // perfectly. `#html-modules` is position: absolute with an inline
  // `top` set by the redraw path — copy it through.
  snap.ghost.style.position = 'absolute';
  snap.ghost.style.top = container.style.top || '0';
  snap.ghost.style.left = '0';
  snap.ghost.style.width = container.style.width || '100%';
  snap.ghost.style.pointerEvents = 'none';
  // Stack just above the live tree so disappearing rows visually
  // sit on top while they fade.
  snap.ghost.style.zIndex = '2';

  let exitingCount = 0;
  for (const g of Array.from(snap.ghost.querySelectorAll<HTMLElement>('.module-group'))) {
    const id = g.dataset['id'];
    if (id !== undefined && id !== '' && !newIds.has(id)) {
      exitingCount++;
    } else {
      g.style.display = 'none';
    }
  }

  if (exitingCount === 0) {
    // Nothing to fade out — skip the ghost entirely.
    return;
  }

  parent.appendChild(snap.ghost);

  const fade = snap.ghost.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration, easing, fill: 'forwards' },
  );
  const cleanup = (): void => {
    snap.ghost.remove();
  };
  fade.addEventListener('finish', cleanup, { once: true });
  // Safety: if `finish` never fires (tab backgrounded, etc.), the
  // ghost would linger. A slightly-delayed remove guarantees cleanup.
  setTimeout(cleanup, duration + 100);
}
