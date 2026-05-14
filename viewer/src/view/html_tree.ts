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

// Sticky rows stack flush — same vertical spacing as natural-flow
// rows. A previous version added a gap here to keep the text halo
// from bleeding onto the parent row above, but the gap made the
// sticky stack visibly wider-spaced than the rest of the tree. The
// halo is sized small enough (see index.html) to stay inside its row.
const STICKY_STEP = ROW_H;

// Pastel palette duplicated from tree.ts so we can colour chips
// identically. Each ancestor name hashes into one slot; the SVG
// renderer uses the same function so colours match across the two.
const SEGMENT_PALETTE: readonly string[] = [
  '#99f6e4',
  '#bae6fd',
  '#c7d2fe',
  '#ddd6fe',
  '#fbcfe8',
  '#a7f3d0',
  '#fde68a',
  '#fecdd3',
];

function colorForSegment(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  const idx = (h >>> 0) % SEGMENT_PALETTE.length;
  return SEGMENT_PALETTE[idx] ?? SEGMENT_PALETTE[0] ?? '#e2e8f0';
}

export interface HtmlModuleTreeOptions {
  readonly onToggle: (id: string) => void;
  readonly onScrollToModule: (moduleId: string) => void;
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
    // Vertical position relative to the parent group; height covers
    // this module's full y-range so its sticky header has somewhere to
    // slide out into when the user scrolls past the descendant content.
    group.style.top = `${(m.y - parentY) * k}px`;
    group.style.height = `${(endYs[i]! - m.y) * k}px`;
    // Indent by one INDENT_PX step per depth — applied relatively so
    // siblings stay flush and the tree visibly nests. Depth-0 sits at
    // the root container's left edge.
    group.style.left = m.modDepth === 0 ? '0' : `${INDENT_PX * k}px`;

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
  header.style.top = `${m.modDepth * STICKY_STEP * k}px`;
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
    // Triangle glyphs match the SVG type-header chevrons (▾ open / ▸
    // closed) and read as navigation affordances rather than the
    // brighter +/- "actions" they replaced. Neutral grey via CSS.
    chevron.textContent = m.expanded ? '▾' : '▸';
    chevron.classList.add(m.expanded ? 'collapse' : 'expand');
  } else {
    chevron.textContent = '▸';
    chevron.classList.add('empty');
  }
  chevron.style.width = `${12 * k}px`;
  chevron.style.marginRight = `${4 * k}px`;
  chevron.style.fontSize = `${12 * k}px`;
  header.appendChild(chevron);

  const chip = document.createElement('span');
  chip.className = 'module-chip';
  chip.textContent = moduleLeafLabel(m.id);
  chip.style.fontSize = `${(m.modDepth === 0 ? 15 : 14) * k}px`;
  chip.style.padding = `0 ${6 * k}px`;
  chip.style.borderRadius = `${4 * k}px`;
  if (m.modDepth !== 0) {
    chip.style.background = m.leafBg.isParent
      ? colorForSegment(m.leafBg.name)
      : '#eaeef4';
  }
  header.appendChild(chip);

  header.addEventListener('click', (event) => {
    event.stopPropagation();
    const naturalTopPx = m.y * k;
    if (naturalTopPx < scrollEl.scrollTop) {
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
