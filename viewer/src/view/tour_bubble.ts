import { marked } from 'marked';

import { forwardWheelToCanvas } from './wheel_forward.ts';

// Yellow sticky-note tour bubble. Draggable, has a pointer triangle
// that hugs the side closest to the anchor target. Buttons live at
// the bottom of the note (Prev, Stop, Next).

export interface BubbleOptions {
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onStop: () => void;
}

export interface BubbleState {
  readonly say: string;
  /** Called every frame to find the current screen-space rect of
   *  the focused element. Returning null hides the pointer. Live
   *  evaluation lets the bubble track the target as the user pans /
   *  scrolls / zooms the canvas, instead of pointing at where the
   *  element WAS when the step started. */
  readonly getAnchor: () => DOMRect | null;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
}

export interface TourBubble {
  show(state: BubbleState): void;
  hide(): void;
}

export function createTourBubble(opts: BubbleOptions): TourBubble {
  let root: HTMLElement | null = null;
  let tailSvg: SVGSVGElement | null = null;
  let tailPath: SVGPathElement | null = null;
  let body: HTMLElement | null = null;
  let counter: HTMLElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;

  // User-set offset from the live anchor's center. When null, the
  // bubble auto-positions next to the anchor every frame. Once the
  // user drags, we record their offset and re-apply it relative to
  // the current anchor — so the bubble follows canvas pans/scrolls
  // while keeping the spot the user chose.
  let userOffset: { dx: number; dy: number } | null = null;
  let drag: { id: number; offX: number; offY: number } | null = null;

  const build = (): void => {
    root = document.createElement('div');
    root.className = 'tour-bubble';

    body = document.createElement('div');
    body.className = 'tour-bubble-body';
    root.appendChild(body);

    // SVG overlay for the tail: a hand-drawn-looking quadratic
    // Bezier from the middle of the bubble's nearest edge to a
    // point on the anchor's bounding box, with an arrowhead at the
    // target end. SVG layer sits just under the bubble body so the
    // body draws on top of it.
    tailSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tailSvg.classList.add('tour-bubble-tail-svg');
    // Arrowhead marker, sized to match the curve stroke.
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'tour-bubble-arrowhead');
    marker.setAttribute('viewBox', '0 -4 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '0');
    marker.setAttribute('markerWidth', '11');
    marker.setAttribute('markerHeight', '11');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'userSpaceOnUse');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    head.setAttribute('d', 'M0,-4 L8,0 L0,4 Z');
    head.setAttribute('fill', '#eab308');
    marker.appendChild(head);
    defs.appendChild(marker);
    tailSvg.appendChild(defs);
    tailPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tailPath.classList.add('tour-bubble-tail');
    tailPath.setAttribute('marker-end', 'url(#tour-bubble-arrowhead)');
    tailSvg.appendChild(tailPath);
    document.body.appendChild(tailSvg);

    const footer = document.createElement('div');
    footer.className = 'tour-bubble-footer';

    prevBtn = mkBtn('‹ Prev', 'tour-bubble-prev', () => opts.onPrev());
    const stopBtn = mkBtn('Stop', 'tour-bubble-stop', () => opts.onStop());
    nextBtn = mkBtn('Next ›', 'tour-bubble-next', () => opts.onNext());

    counter = document.createElement('span');
    counter.className = 'tour-bubble-counter';

    footer.appendChild(prevBtn);
    footer.appendChild(stopBtn);
    footer.appendChild(nextBtn);
    footer.appendChild(counter);
    root.appendChild(footer);

    // Drag from anywhere except the buttons. preventDefault disabled
    // on the buttons so their click events fire.
    root.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('button')) return;
      const rect = root!.getBoundingClientRect();
      drag = { id: e.pointerId, offX: e.clientX - rect.left, offY: e.clientY - rect.top };
      root!.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    root.addEventListener('pointermove', (e) => {
      if (drag === null || e.pointerId !== drag.id) return;
      const newLeft = e.clientX - drag.offX;
      const newTop = e.clientY - drag.offY;
      // Position as anchor + offset so the bubble keeps tracking
      // the diagram after the drag ends. When there's no anchor
      // (text-only step), fall back to absolute coords.
      const a = current?.getAnchor() ?? null;
      if (a !== null) {
        const ax = a.left + a.width / 2;
        const ay = a.top + a.height / 2;
        userOffset = { dx: newLeft - ax, dy: newTop - ay };
      } else {
        userOffset = { dx: newLeft, dy: newTop };
      }
      root!.style.left = `${newLeft}px`;
      root!.style.top = `${newTop}px`;
      // Pointer side/offset will refresh on the next rAF tick.
    });
    const endDrag = (e: PointerEvent): void => {
      if (drag === null || e.pointerId !== drag.id) return;
      if (root!.hasPointerCapture(e.pointerId)) root!.releasePointerCapture(e.pointerId);
      drag = null;
    };
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);

    // Wheel events on the bubble forward to the canvas so the
    // user can pan/zoom the diagram even when the cursor is on
    // top of the sticky note. Same pattern as the edge picker /
    // arrow disambig popovers.
    forwardWheelToCanvas(root);
    document.body.appendChild(root);
  };

  let current: BubbleState | null = null;
  let rafId: number | null = null;

  const applyOffset = (anchor: DOMRect | null): void => {
    if (root === null || userOffset === null) return;
    if (anchor === null) {
      // Anchor went away — keep the bubble at its last screen
      // position rather than snapping to (0,0).
      return;
    }
    const ax = anchor.left + anchor.width / 2;
    const ay = anchor.top + anchor.height / 2;
    root.style.left = `${ax + userOffset.dx}px`;
    root.style.top = `${ay + userOffset.dy}px`;
  };

  const autoPositionFor = (anchor: DOMRect | null): void => {
    if (root === null) return;
    if (anchor === null) {
      // No anchor → park at top-center under the tour bar.
      root.style.left = `calc(50% - ${root.offsetWidth / 2}px)`;
      root.style.top = '64px';
      return;
    }
    // Pick the side with the most room. Default: right of anchor.
    const W = root.offsetWidth || 280;
    const H = root.offsetHeight || 140;
    const padding = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rightRoom = vw - anchor.right;
    const leftRoom = anchor.left;
    const belowRoom = vh - anchor.bottom;
    const aboveRoom = anchor.top;

    let x: number;
    let y: number;
    if (rightRoom >= W + padding) {
      x = anchor.right + padding;
      y = clamp(anchor.top + anchor.height / 2 - H / 2, 8, vh - H - 8);
    } else if (leftRoom >= W + padding) {
      x = anchor.left - W - padding;
      y = clamp(anchor.top + anchor.height / 2 - H / 2, 8, vh - H - 8);
    } else if (belowRoom >= H + padding) {
      y = anchor.bottom + padding;
      x = clamp(anchor.left + anchor.width / 2 - W / 2, 8, vw - W - 8);
    } else {
      y = clamp(aboveRoom - H - padding, 8, vh - H - 8);
      x = clamp(anchor.left + anchor.width / 2 - W / 2, 8, vw - W - 8);
    }
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
  };

  const updatePointer = (anchor: DOMRect | null): void => {
    if (tailSvg === null || tailPath === null || root === null) return;
    if (anchor === null) {
      tailSvg.style.display = 'none';
      return;
    }
    const bubble = root.getBoundingClientRect();
    // If the bubble overlaps the anchor, hide the tail — pointing
    // at a target you're already covering looks broken.
    const overlaps =
      bubble.left < anchor.right &&
      bubble.right > anchor.left &&
      bubble.top < anchor.bottom &&
      bubble.bottom > anchor.top;
    if (overlaps) {
      tailSvg.style.display = 'none';
      return;
    }
    tailSvg.style.display = '';

    const bcx = bubble.left + bubble.width / 2;
    const bcy = bubble.top + bubble.height / 2;
    const acx = anchor.left + anchor.width / 2;
    const acy = anchor.top + anchor.height / 2;

    // Pick the bubble's EXIT side and the anchor's ENTRY side based
    // on which axis dominates the offset between them. Horizontal
    // dominant → bubble exits left/right, anchor enters the
    // opposite side. Same for vertical. Both endpoints sit on the
    // MIDPOINTS of those sides — guarantees the arrowhead lands
    // visually centered on the side facing the bubble.
    const dxc = acx - bcx;
    const dyc = acy - bcy;
    type Side = 'left' | 'right' | 'top' | 'bottom';
    let exitSide: Side;
    let entrySide: Side;
    if (Math.abs(dxc) >= Math.abs(dyc)) {
      exitSide = dxc > 0 ? 'right' : 'left';
      entrySide = dxc > 0 ? 'left' : 'right';
    } else {
      exitSide = dyc > 0 ? 'bottom' : 'top';
      entrySide = dyc > 0 ? 'top' : 'bottom';
    }

    const sideMidpoint = (rect: DOMRect, s: Side): { x: number; y: number } => {
      switch (s) {
        case 'right': return { x: rect.right, y: rect.top + rect.height / 2 };
        case 'left':  return { x: rect.left,  y: rect.top + rect.height / 2 };
        case 'bottom':return { x: rect.left + rect.width / 2, y: rect.bottom };
        default:      return { x: rect.left + rect.width / 2, y: rect.top };
      }
    };
    const sideOutward = (s: Side): { x: number; y: number } => {
      switch (s) {
        case 'right': return { x: 1, y: 0 };
        case 'left':  return { x: -1, y: 0 };
        case 'bottom':return { x: 0, y: 1 };
        default:      return { x: 0, y: -1 };
      }
    };

    const start = sideMidpoint(bubble, exitSide);
    const rawEnd = sideMidpoint(anchor, entrySide);
    const startDir = sideOutward(exitSide);
    const endDir = sideOutward(entrySide);
    // Tiny gap between arrowhead and target — matches one layout
    // grid cell (8px) so the head doesn't kiss the box.
    const GAP = 8;
    const end = {
      x: rawEnd.x + endDir.x * GAP,
      y: rawEnd.y + endDir.y * GAP,
    };

    // Cubic Bezier with two control points, each pushed
    // perpendicular to its endpoint side. Tangent at start is
    // (start → cp1) ⇒ along startDir ⇒ perpendicular to the bubble
    // side. Same for end (end ← cp2), so the arrowhead lands
    // perpendicular to the anchor side. Marker's `orient="auto"`
    // picks up that tangent and rotates the arrowhead accordingly.
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const curl = Math.min(140, Math.max(28, dist * 0.4));
    const cp1x = start.x + startDir.x * curl;
    const cp1y = start.y + startDir.y * curl;
    const cp2x = end.x + endDir.x * curl;
    const cp2y = end.y + endDir.y * curl;

    tailSvg.setAttribute('width', String(window.innerWidth));
    tailSvg.setAttribute('height', String(window.innerHeight));
    tailSvg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    tailPath.setAttribute(
      'd',
      `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    );
  };

  const show = (state: BubbleState): void => {
    if (root === null) build();
    // Render markdown so the AI can use **bold**, `code`, lists,
    // links, etc. `marked.parse` escapes raw HTML by default,
    // which keeps us safe even though the JSON comes from a
    // mostly-trusted server pipeline.
    body!.innerHTML = marked.parse(state.say, { async: false }) as string;
    counter!.textContent = `${state.stepIndex + 1} / ${state.stepCount}`;
    prevBtn!.disabled = !state.hasPrev;
    nextBtn!.disabled = !state.hasNext;
    current = state;
    // Step-enter: auto-place if the user hasn't established an
    // offset yet; otherwise re-apply their offset against the new
    // step's anchor.
    const initial = state.getAnchor();
    if (userOffset === null) autoPositionFor(initial);
    else applyOffset(initial);
    updatePointer(initial);
    if (rafId === null) rafId = requestAnimationFrame(tick);
  };

  const tick = (): void => {
    rafId = null;
    if (current === null || root === null) return;
    const a = current.getAnchor();
    // Re-attach the bubble to the anchor every frame: either via
    // auto-position (no drag yet) or via the user's stored offset
    // (after they've moved the note). Either way the bubble stays
    // glued to the diagram as the user pans / scrolls / zooms.
    if (userOffset === null) autoPositionFor(a);
    else applyOffset(a);
    updatePointer(a);
    rafId = requestAnimationFrame(tick);
  };

  const hide = (): void => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    if (root !== null) root.remove();
    if (tailSvg !== null) tailSvg.remove();
    root = null;
    tailSvg = null;
    tailPath = null;
    body = null;
    counter = null;
    prevBtn = null;
    nextBtn = null;
    userOffset = null;
    current = null;
    drag = null;
  };

  return { show, hide };
}

function mkBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
