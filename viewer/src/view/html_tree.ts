// HTML overlay rendering for the module tree.
//
// The module column lives as a nested HTML structure so native CSS
// `position: sticky` handles the breadcrumb behaviour with no JS
// simulation. Each module is a `<div class="module-group">` containing
// a sticky header + the nested groups for its descendants; depth d's
// header sticks at `top: d * ROW_H` so ancestors stack at the top as
// the user scrolls into deeper modules.
//
// d3.zoom still owns pan + zoom in the SVG; on every zoom event a
// one-line mirror in zoom.ts writes `-t.y` to the scroll container's
// scrollTop. Native sticky responds to scrollTop changes regardless of
// whether the user or JS moved it, so the breadcrumb is fully native.

import { INDENT_PX, ROW_H, moduleLeafLabel } from '../analysis/layout_metrics.ts';
import type { Layout } from '../analysis/layout_model.ts';
import type { Side } from '../data/schema.ts';

// Sticky rows stack flush — same vertical spacing as natural-flow
// rows. A previous version added a gap here to keep the text halo
// from bleeding onto the parent row above, but the gap made the
// sticky stack visibly wider-spaced than the rest of the tree. The
// halo is sized small enough (see index.html) to stay inside its row.
const STICKY_STEP = ROW_H;

/** Viewport-y pixel where a module of `modDepth` sits when it's in the
 *  sticky stack (just below its ancestors). The renderer uses this for
 *  `header.style.top`; the scroll-to-module action targets it so a
 *  clicked sticky module lands at exactly its sticky position — its
 *  row just below the ancestor stack, its first child as the next
 *  visible row. Both call sites must agree, hence one helper. */
export function moduleStickyTopPx(modDepth: number, k: number): number {
  return modDepth * STICKY_STEP * k;
}

/** A header is "stuck" — pinned to the sticky stack instead of sitting
 *  at its natural y — when its natural content-y is above the sticky
 *  threshold for its depth. `naturalTopInContent` is the row's natural
 *  top in `scrollEl`-content coords. Depth matters: a depth-2 row
 *  sticks two rows earlier than a depth-0 row, so the threshold has
 *  to include `moduleStickyTopPx(modDepth, k)`, not just `scrollTop`.
 *  Without this, a row in the narrow window where it's just entered
 *  the sticky stack would be treated as un-stuck and a click would
 *  toggle instead of scroll-back (image #167). */
export function isModuleStuck(
  naturalTopInContent: number,
  scrollTop: number,
  modDepth: number,
  k: number,
): boolean {
  return naturalTopInContent < scrollTop + moduleStickyTopPx(modDepth, k);
}

export interface HtmlModuleTreeOptions {
  readonly onToggle: (id: string) => void;
  readonly onScrollToModule: (moduleId: string) => void;
  /** Cmd/Ctrl+click on a module label → open its source file in the
   *  code panel. The host looks the file up in the span index. */
  readonly onShowCode: (id: string) => void;
  /** When in union-diff mode, maps a module's full id (crate-prefixed
   *  path used as `m.id` in the layout) to the side it lives on. The
   *  renderer applies a `side-base|side-head|side-both` class to the
   *  module-group so CSS can paint a left-edge color bar. Omitted /
   *  empty map → no styling, single-snapshot behaviour. */
  readonly sideByModule?: ReadonlyMap<string, Side>;
  /** Per-module subtree rollup. Renderer paints `+N -M` next to the
   *  module's leaf label whenever counts are non-zero — lets the user
   *  see "there are changes in here" without expanding. Omitted /
   *  empty → no badges. */
  readonly rollupByModule?: ReadonlyMap<string, { readonly add: number; readonly del: number }>;
}

/** Render the module tree as nested HTML inside `container`. `k` is the
 *  current zoom scale, used to size each group's pixel extents so they
 *  line up with the SVG content's data y-positions. */
export function renderHtmlModuleTree(
  container: HTMLElement,
  layout: Layout,
  k: number,
  scrollEl: HTMLElement,
  opts: HtmlModuleTreeOptions,
): void {
  const modules = layout.modules;
  const endYs = computeEndYs(modules, layout.totalHeight);

  // Full rebuild on every draw. The module set is small (tens of rows)
  // and the data-join machinery isn't worth the maintenance here; the
  // SVG side keyed-join was needed for arrow tweening, not for static
  // tree rows that don't animate.
  container.replaceChildren();

  // Stack of (parentDom, parentDataY) so nested groups know what y to
  // subtract — module-groups are positioned absolutely relative to
  // their parent's box.
  const stack: Array<{ readonly dom: HTMLElement; readonly baseY: number }> = [
    { dom: container, baseY: 0 },
  ];

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    if (!m) continue;

    while (stack.length > m.modDepth + 1) stack.pop();
    const top = stack[stack.length - 1];
    if (!top) continue;
    const { dom: parent, baseY: parentY } = top;

    const group = document.createElement('div');
    group.className = 'module-group';
    group.dataset.id = m.id;
    // Union-diff side coloring. When the host provides a sideByModule
    // map (only in unified mode), tag the group's element so CSS can
    // paint a left-edge bar. Skip `both` for v1 because we don't yet
    // distinguish body-modified Both from unchanged Both (that gates
    // on diff-hunk intersection, deferred to a follow-up). So only
    // `base` (removed) and `head` (added) modules get a bar.
    const side = opts.sideByModule?.get(m.id);
    if (side === 'base' || side === 'head') {
      group.classList.add(`side-${side}`);
    }
    // Vertical position relative to the parent group; height covers
    // this module's full y-range so its sticky header has somewhere to
    // slide out into when the user scrolls past the descendant content.
    group.style.top = `${(m.y - parentY) * k}px`;
    group.style.height = `${(endYs[i]! - m.y) * k}px`;
    // Indent by one INDENT_PX step per depth — applied relatively so
    // siblings stay flush and the tree visibly nests. Depth-0 sits at
    // the root container's left edge.
    group.style.left = m.modDepth === 0 ? '0' : `${INDENT_PX * k}px`;
    // VS Code-style indent guide. When this module is expanded we
    // draw a thin vertical line from below its chevron down through
    // the entire descendant block (the group's height already covers
    // it). CSS reads these custom properties on the `::before` pseudo
    // so the colour/width live in one place. Pixel values scale with
    // the zoom factor so the guide aligns with the chevron at any k.
    if (m.expanded && m.hasChildren) {
      group.classList.add('is-expanded');
      // Chevron center: half its rendered width (14*k); the guide
      // drops 2px below the row to clear the chevron glyph.
      group.style.setProperty('--guide-x', `${7 * k}px`);
      group.style.setProperty('--guide-top', `${ROW_H * k + 2}px`);
    }

    group.appendChild(renderHeader(m, k, scrollEl, opts));

    parent.appendChild(group);
    stack.push({ dom: group, baseY: m.y });
  }

  installScrollVisibility(container, scrollEl, k);
}

/** Hide a sticky header whose visual position has slid above its
 *  parent's sticky offset (where the parent's row fully covers it).
 *  CSS sticky pulls the header upward when its containing block's
 *  bottom approaches the sticky position, which visually puts the
 *  header into a shallower ancestor's sticky zone. We want only the
 *  currently active sticky per depth on screen.
 *
 *  Performance notes:
 *   • Headers are cached at render time — no per-scroll querySelectorAll.
 *   • Read-then-write loop avoids layout thrashing (one layout per frame
 *     instead of one per header).
 *   • rAF throttle collapses scroll bursts to one update per frame. */
function installScrollVisibility(
  container: HTMLElement,
  scrollEl: HTMLElement,
  k: number,
): void {
  type Host = { __sfHideStaleScroll?: () => void };
  const host = scrollEl as unknown as Host;
  if (host.__sfHideStaleScroll) {
    scrollEl.removeEventListener('scroll', host.__sfHideStaleScroll);
    delete host.__sfHideStaleScroll;
  }

  // Snapshot headers + their depth once per render. The DOM was just
  // built by the caller, so re-querying every scroll is wasted work.
  const headers = Array.from(
    container.querySelectorAll<HTMLElement>('.module-header'),
  ).map((el) => ({ el, depth: Number(el.dataset.depth ?? '0') }));

  const apply = (): void => {
    if (headers.length === 0) return;
    const containerTop = scrollEl.getBoundingClientRect().top;
    // Read phase: collect bounding rects up front. Interleaving reads
    // and writes triggers a layout per header (each style mutation
    // invalidates layout for the next getBoundingClientRect).
    const opacities = new Array<number>(headers.length);
    for (let i = 0; i < headers.length; i++) {
      const entry = headers[i]!;
      // Fade range: from the row's own sticky-top (fully visible) down
      // to its parent's sticky-top (fully covered, opacity 0). When
      // the row's container ends and CSS sticky pulls the row upward,
      // opacity ramps down linearly so the row dissolves smoothly into
      // the sticky stack instead of vanishing in one frame.
      const ownStickyTop = entry.depth * STICKY_STEP * k;
      const parentStickyTop = (entry.depth - 1) * STICKY_STEP * k;
      const viewportY = entry.el.getBoundingClientRect().top - containerTop;
      let opacity: number;
      if (viewportY >= ownStickyTop - 0.5) {
        opacity = 1;
      } else if (viewportY <= parentStickyTop + 0.5) {
        opacity = 0;
      } else {
        opacity = (viewportY - parentStickyTop) / (ownStickyTop - parentStickyTop);
      }
      opacities[i] = opacity;
    }
    // Write phase: only mutate when state actually changes, so a
    // mostly-stable scroll doesn't churn style attributes.
    for (let i = 0; i < headers.length; i++) {
      const entry = headers[i]!;
      const next = opacities[i]!;
      const cur = entry.el.style.opacity === '' ? 1 : Number(entry.el.style.opacity);
      if (Math.abs(cur - next) > 0.01) {
        entry.el.style.opacity = next >= 0.999 ? '' : String(next);
      }
      // Mirror the same fade onto the module-group so its indent-guide
      // pseudo-element dissolves in lockstep with the row text.
      // ALSO clamp the guide's vertical start so it doesn't extend
      // into the sticky-stack area: when this header sticks at
      // depth * STICKY_STEP, the line should begin just below the
      // sticky row in viewport-space — not at its natural pre-scroll
      // position which is now far above the visible area. Without
      // this clamp the line draws straight through the sticky headers
      // above (cf. screenshot).
      const group = entry.el.parentElement;
      if (group !== null) {
        const curGuide = group.style.getPropertyValue('--guide-opacity');
        const curGuideN = curGuide === '' ? 1 : Number(curGuide);
        if (Math.abs(curGuideN - next) > 0.01) {
          if (next >= 0.999) {
            group.style.removeProperty('--guide-opacity');
          } else {
            group.style.setProperty('--guide-opacity', String(next));
          }
        }
        if (group.classList.contains('is-expanded')) {
          const groupViewportTop = group.getBoundingClientRect().top - containerTop;
          const naturalGuideTop = ROW_H * k + 2; // matches the value set at render time
          const stickyBottomViewport = (entry.depth * STICKY_STEP + ROW_H) * k + 2;
          const naturalGuideViewport = groupViewportTop + naturalGuideTop;
          const clampedViewport = Math.max(naturalGuideViewport, stickyBottomViewport);
          const newGuideTop = clampedViewport - groupViewportTop;
          const cur = group.style.getPropertyValue('--guide-top');
          const target = `${newGuideTop}px`;
          if (cur !== target) group.style.setProperty('--guide-top', target);
        }
      }
      // Disable pointer events on fully faded rows so the click handler
      // doesn't fire on something the user can't see.
      const wantEvents = next > 0.05;
      const curEvents = entry.el.style.pointerEvents !== 'none';
      if (wantEvents !== curEvents) {
        entry.el.style.pointerEvents = wantEvents ? '' : 'none';
      }
    }
  };

  let rafQueued = false;
  const onScroll = (): void => {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => {
      rafQueued = false;
      apply();
    });
  };
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  host.__sfHideStaleScroll = onScroll;
  // Apply once now so visibility is correct on first paint after a
  // render — without this, rows that should be hidden at the current
  // scroll position remain visible until the next scroll event.
  apply();
}

function renderHeader(
  m: Layout['modules'][number],
  k: number,
  scrollEl: HTMLElement,
  opts: HtmlModuleTreeOptions,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'module-header';
  header.dataset.depth = String(m.modDepth);
  if (m.modDepth === 0) header.classList.add('crate-tier');
  // Every pixel value scales with the current zoom k so the HTML row
  // matches the underlying SVG band size at any zoom. Without this,
  // collapsed module-groups at low k become shorter than the constant
  // ROW_H, and adjacent rows visually overlap (image #65). The text
  // becomes smaller when zoomed out — the user can zoom in to read —
  // but the layout never breaks.
  header.style.top = `${moduleStickyTopPx(m.modDepth, k)}px`;
  header.style.height = `${ROW_H * k}px`;
  header.style.width = `${m.hitWidth * k}px`;
  // Shallower depth = higher z-index so a parent's sticky header paints
  // OVER a child's when they briefly overlap. Without this, when a
  // child group ends and its sticky header slides up out of view, it
  // would visually cross over (in front of) the parent header that's
  // sticking at a shallower top, because DOM order puts the child later
  // in paint order.
  header.style.zIndex = `${1000 - m.modDepth}`;

  const chevron = document.createElement('span');
  chevron.className = 'module-chevron';
  if (m.hasChildren) {
    // VS Code-style chevron: a single right-pointing angle that rotates
    // 90° when expanded. Reads as a thin navigation affordance rather
    // than a filled triangle.
    chevron.textContent = '›';
    chevron.classList.add(m.expanded ? 'collapse' : 'expand');
    if (m.expanded) {
      // Rotating `›` 90° leaves the visible tip slightly left of the
      // collapsed-chevron column because `›` isn't centred in its
      // em-box. A small post-rotation X-shift brings the expanded
      // glyph's tip into the same vertical line as `>` and the indent
      // guide below. Translate is written LEFT of `rotate` so CSS
      // applies it in the post-rotation (screen) frame.
      chevron.style.transform = `translateX(${2 * k}px) rotate(90deg)`;
    }
  } else {
    chevron.textContent = '›';
    chevron.classList.add('empty');
  }
  chevron.style.display = 'inline-block';
  chevron.style.width = `${14 * k}px`;
  chevron.style.marginRight = `${4 * k}px`;
  chevron.style.fontSize = `${20 * k}px`;
  chevron.style.lineHeight = '1';
  chevron.style.fontWeight = '700';
  header.appendChild(chevron);

  const chip = document.createElement('span');
  chip.className = 'module-chip';
  chip.textContent = moduleLeafLabel(m.id);
  chip.style.fontSize = `${(m.modDepth === 0 ? 15 : 14) * k}px`;
  // No background or border on the chip — legibility comes from the
  // text-shadow halo on `.module-header`. If we want to bring chips
  // back later, restore the background via CSS rather than JS so
  // styling stays in one file.
  header.appendChild(chip);

  // Union-diff rollup badge: shows the subtree's add/del totals.
  // Without this, a collapsed crate communicates nothing about its
  // descendants' changes — which is the #1 reason "diff mode looks
  // identical to normal mode" on first load (every top-level row is
  // `both` and most paths to changes are several modules deep).
  const rollup = opts.rollupByModule?.get(m.id);
  if (rollup !== undefined && (rollup.add > 0 || rollup.del > 0)) {
    const badge = document.createElement('span');
    badge.className = 'rollup-badge';
    badge.style.fontSize = `${10 * k}px`;
    if (rollup.add > 0) {
      const add = document.createElement('span');
      add.className = 'rb-add';
      add.textContent = `+${rollup.add}`;
      badge.appendChild(add);
    }
    if (rollup.del > 0) {
      const del = document.createElement('span');
      del.className = 'rb-del';
      del.textContent = `−${rollup.del}`;
      badge.appendChild(del);
    }
    header.appendChild(badge);
  }

  header.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      opts.onShowCode(m.id);
      return;
    }
    // Module's natural top in canvas-content coords is offset by
    // scrollEl.clientHeight (the TOP_PADDING). If the row is in the
    // sticky stack (depth-aware threshold via isModuleStuck), a click
    // means "scroll back to it"; otherwise it toggles expansion. The
    // depth in the threshold matters — a depth-2 row sticks two rows
    // earlier than a depth-0 row, so a flat `< scrollTop` check
    // misfires in the narrow window where the row has just entered
    // the stack (image #167).
    const naturalTopInContent = scrollEl.clientHeight + m.y * k;
    if (isModuleStuck(naturalTopInContent, scrollEl.scrollTop, m.modDepth, k)) {
      opts.onScrollToModule(m.id);
    } else {
      opts.onToggle(m.id);
    }
  });

  return header;
}

/** For each module compute the y where its content ends — that is, the
 *  y of the next module at the same or shallower depth, or totalHeight
 *  if no such module exists. Used to size each module-group so its
 *  sticky header has the right amount of room to scroll through. */
function computeEndYs(
  modules: readonly Layout['modules'][number][],
  totalHeight: number,
): number[] {
  const endYs = new Array<number>(modules.length).fill(totalHeight);
  const pending: number[] = [];
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i]!;
    while (pending.length > 0) {
      const top = pending[pending.length - 1]!;
      if (modules[top]!.modDepth >= m.modDepth) {
        endYs[top] = m.y;
        pending.pop();
      } else {
        break;
      }
    }
    pending.push(i);
  }
  return endYs;
}
