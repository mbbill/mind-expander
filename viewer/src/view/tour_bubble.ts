import { marked } from 'marked';

import { forwardWheelToCanvas } from './wheel_forward.ts';

// Yellow sticky-note tour bubble. Draggable, has a pointer triangle
// that hugs the side closest to the anchor target. Buttons live at
// the bottom of the note (Prev, Stop, Next).

export interface BubbleOptions {
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onStop: () => void;
  /** Returns a rect the bubble should avoid covering (e.g. the
   *  open code panel). Queried every rAF tick so toggling the
   *  panel mid-tour re-flows the bubble within one frame. Return
   *  null when nothing needs avoiding. */
  readonly getAvoidRect?: () => DOMRect | null;
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
  // Global keyboard shortcuts (P / N / Esc) — attached on build() so
  // they only fire while a tour bubble is alive, and detached on
  // hide() so no stray listeners survive. Held at closure scope so
  // hide() can pass the SAME function instance to removeEventListener.
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;

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

    // Button labels reveal their keyboard shortcuts with an
    // underlined letter (P / N) — matches the global keydown
    // listener attached below. mkBtn now accepts HTML for the label
    // so we can render a real `<u>` rather than a styled span.
    prevBtn = mkBtn('Prev (<u>P</u>)', 'tour-bubble-prev', () => opts.onPrev());
    const stopBtn = mkBtn('Stop (Esc)', 'tour-bubble-stop', () => opts.onStop());
    nextBtn = mkBtn('Next (<u>N</u>)', 'tour-bubble-next', () => opts.onNext());

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
      // Cancel any in-flight step-transition animation: the user is
      // taking direct control, so positions must be instant not eased.
      animStart = 0;
      animOrigin = null;
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

    // Tour-mode keyboard shortcuts: P → Prev, N → Next, Esc → Stop.
    // Only active while the bubble is alive (tour playing). We
    // suppress shortcuts while the user is typing in any text-entry
    // surface so P / N don't hijack normal keystrokes there.
    keyHandler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t !== null) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      if (e.key === 'p' || e.key === 'P') {
        if (prevBtn !== null && !prevBtn.disabled) {
          e.preventDefault();
          opts.onPrev();
        }
      } else if (e.key === 'n' || e.key === 'N') {
        if (nextBtn !== null && !nextBtn.disabled) {
          e.preventDefault();
          opts.onNext();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        opts.onStop();
      }
    };
    document.addEventListener('keydown', keyHandler);
  };

  let current: BubbleState | null = null;
  let rafId: number | null = null;

  // Minimum visible portion of the bubble after auto-following the
  // anchor. Without this clamp, a stored userOffset combined with an
  // anchor that pans far off-screen would drag the bubble out of
  // reach — no way to grab it back, since the drag handle is on the
  // bubble itself.
  const MIN_VISIBLE = 40;

  const clampIntoViewport = (left: number, top: number): { left: number; top: number } => {
    if (root === null) return { left, top };
    const W = root.offsetWidth || 280;
    const H = root.offsetHeight || 140;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: clamp(left, MIN_VISIBLE - W, vw - MIN_VISIBLE),
      top: clamp(top, MIN_VISIBLE - H, vh - MIN_VISIBLE),
    };
  };

  // Compute where the bubble SHOULD be this frame, without writing to
  // the DOM. The position helpers used to set style.left/top directly;
  // splitting compute from apply lets a single writer
  // (`applyPositionAnimated`) decide whether to snap or interpolate.
  // Returns null when no position can be derived (e.g. anchor is gone
  // but a userOffset is stored — keep the bubble where it is).
  const computeOffsetPos = (anchor: DOMRect | null): { left: number; top: number } | null => {
    if (root === null || userOffset === null) return null;
    if (anchor === null) return null;
    const ax = anchor.left + anchor.width / 2;
    const ay = anchor.top + anchor.height / 2;
    return clampIntoViewport(ax + userOffset.dx, ay + userOffset.dy);
  };

  const computeAutoPos = (anchor: DOMRect | null): { left: number; top: number } => {
    if (root === null) return { left: 0, top: 0 };
    const W = root.offsetWidth || 280;
    const H = root.offsetHeight || 140;
    if (anchor === null) {
      // No anchor → park at top-center under the tour bar.
      return { left: window.innerWidth / 2 - W / 2, top: 64 };
    }
    // Pick the side with the most room. Default: right of anchor.
    // Padding is in layout-grid units (1 grid = 8px). 8 grids gives
    // the tail enough length to curve and keeps the bubble from
    // crowding the element it's about.
    const padding = 64;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Shrink the effective viewport's right/left edges by any
    // edge-anchored avoid rect (the open code panel). This makes the
    // "right side" room calculation correctly drop to "too small"
    // when the panel covers the right, so the bubble falls through
    // to left / below / above. Heuristic: panel "anchored to the
    // right" iff its right edge is within 2px of the window edge AND
    // it doesn't span the full width.
    const avoid = opts.getAvoidRect?.() ?? null;
    let rightEdge = vw;
    let leftEdge = 0;
    if (avoid !== null) {
      if (avoid.right >= vw - 2 && avoid.left > 0) rightEdge = avoid.left;
      else if (avoid.left <= 2 && avoid.right < vw) leftEdge = avoid.right;
    }
    const rightRoom = rightEdge - anchor.right;
    const leftRoom = anchor.left - leftEdge;
    const belowRoom = vh - anchor.bottom;
    const aboveRoom = anchor.top;

    if (rightRoom >= W + padding) {
      return {
        left: anchor.right + padding,
        top: clamp(anchor.top + anchor.height / 2 - H / 2, 8, vh - H - 8),
      };
    }
    if (leftRoom >= W + padding) {
      return {
        left: anchor.left - W - padding,
        top: clamp(anchor.top + anchor.height / 2 - H / 2, 8, vh - H - 8),
      };
    }
    if (belowRoom >= H + padding) {
      return {
        left: clamp(anchor.left + anchor.width / 2 - W / 2, leftEdge + 8, rightEdge - W - 8),
        top: anchor.bottom + padding,
      };
    }
    return {
      left: clamp(anchor.left + anchor.width / 2 - W / 2, leftEdge + 8, rightEdge - W - 8),
      top: clamp(aboveRoom - H - padding, 8, vh - H - 8),
    };
  };

  // Animation state for the step-transition glide. animStart === 0
  // means "no animation in progress, snap directly to target". On
  // every step transition (show()), we capture the bubble's CURRENT
  // displayed position as `animOrigin` and start a 220ms ramp. The
  // rAF tick recomputes the target each frame (anchor-tracked) and
  // blends origin→target with easing; once the window elapses we
  // snap to target as before. Driving this in JS (not CSS) avoids
  // fighting the rAF anchor-follow with a transition that would
  // constantly lag.
  const ANIM_MS = 220;
  let animStart = 0;
  let animOrigin: { left: number; top: number } | null = null;

  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

  const applyPositionAnimated = (target: { left: number; top: number } | null): void => {
    if (root === null || target === null) return;
    const now = performance.now();
    if (animStart > 0 && animOrigin !== null && now - animStart < ANIM_MS) {
      const t = easeOutCubic((now - animStart) / ANIM_MS);
      const left = animOrigin.left + (target.left - animOrigin.left) * t;
      const top = animOrigin.top + (target.top - animOrigin.top) * t;
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      return;
    }
    // Animation finished (or never started): snap to target.
    root.style.left = `${target.left}px`;
    root.style.top = `${target.top}px`;
  };

  const computeTargetForFrame = (anchor: DOMRect | null): { left: number; top: number } => {
    if (userOffset !== null) {
      // Stored drag offset — track the anchor's centre + offset.
      const fromOffset = computeOffsetPos(anchor);
      if (fromOffset !== null) return fromOffset;
    }
    return computeAutoPos(anchor);
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

    type Side = 'left' | 'right' | 'top' | 'bottom';
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

    // Entry side is always left OR right of the anchor — top/bottom
    // entries land on a thin sliver for member rows and read as
    // pointing AT the gap above/below the row rather than at the row
    // itself. Picking the closer horizontal side (relative to the
    // bubble's center) keeps the arrowhead on the row's body.
    const entrySide: Side = bcx < acx ? 'left' : 'right';
    // Bubble exit side: pick the side facing the dominant direction
    // the tail has to travel. Measuring how far past each edge the
    // anchor sits (its outward separation) reflects the actual path:
    // the side with the largest separation is the direction we
    // mostly travel. Closest-edge alone was wrong here — when the
    // anchor was just past the right edge but far below it,
    // closest-edge picked right and the tail had to swing 90° down.
    const rightSep = Math.max(0, acx - bubble.right);
    const leftSep = Math.max(0, bubble.left - acx);
    const bottomSep = Math.max(0, acy - bubble.bottom);
    const topSep = Math.max(0, bubble.top - acy);
    const exitCandidates: ReadonlyArray<readonly [Side, number]> = [
      ['right', rightSep],
      ['left', leftSep],
      ['bottom', bottomSep],
      ['top', topSep],
    ];
    let exitSide: Side = 'right';
    let bestSep = -1;
    for (const [s, sep] of exitCandidates) {
      if (sep > bestSep) { bestSep = sep; exitSide = s; }
    }

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
    // Decide whether to keep or drop the stored userOffset against
    // the new anchor (same rule as before — see the offset-mostly-
    // visible check). This must run BEFORE we read the displayed
    // position, since dropping the offset changes which compute path
    // produces the target.
    const initial = state.getAnchor();
    if (userOffset !== null && !offsetWouldBeMostlyOnScreen(initial)) {
      userOffset = null;
    }
    // Capture the bubble's current displayed position to use as the
    // animation origin. parseFloat('') === NaN on the very first
    // show() (no prior left/top); in that case skip animation and
    // snap, so the bubble doesn't fly in from (0, 0).
    const priorLeft = parseFloat(root!.style.left);
    const priorTop = parseFloat(root!.style.top);
    const hadPriorPosition =
      current !== null && Number.isFinite(priorLeft) && Number.isFinite(priorTop);
    current = state;
    if (hadPriorPosition) {
      animOrigin = { left: priorLeft, top: priorTop };
      animStart = performance.now();
    } else {
      animOrigin = null;
      animStart = 0;
    }
    applyPositionAnimated(computeTargetForFrame(initial));
    updatePointer(initial);
    if (rafId === null) rafId = requestAnimationFrame(tick);
  };

  // True iff applying the stored userOffset against this anchor
  // would leave at least half the bubble's width and half its height
  // inside the viewport. "Mostly visible" is a softer test than the
  // rAF clamp — the clamp keeps a sliver reachable; this check
  // decides whether the stored offset still produces a usable layout
  // or should be abandoned in favour of auto-positioning.
  const offsetWouldBeMostlyOnScreen = (anchor: DOMRect | null): boolean => {
    if (root === null || userOffset === null || anchor === null) return false;
    const W = root.offsetWidth || 280;
    const H = root.offsetHeight || 140;
    const left = anchor.left + anchor.width / 2 + userOffset.dx;
    const top = anchor.top + anchor.height / 2 + userOffset.dy;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visibleW = Math.max(0, Math.min(left + W, vw) - Math.max(left, 0));
    const visibleH = Math.max(0, Math.min(top + H, vh) - Math.max(top, 0));
    return visibleW >= W / 2 && visibleH >= H / 2;
  };

  const tick = (): void => {
    rafId = null;
    if (current === null || root === null) return;
    const a = current.getAnchor();
    // Re-attach the bubble to the anchor every frame so it stays
    // glued to the diagram as the user pans / scrolls / zooms.
    // While a step transition is mid-glide, applyPositionAnimated
    // blends the live target with the captured origin; afterwards
    // it snaps directly. Recomputing the target each frame means
    // the eased glide ends up wherever the anchor lives NOW, not
    // where it was when the step started.
    applyPositionAnimated(computeTargetForFrame(a));
    updatePointer(a);
    rafId = requestAnimationFrame(tick);
  };

  const hide = (): void => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    if (keyHandler !== null) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
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
    animStart = 0;
    animOrigin = null;
  };

  return { show, hide };
}

// `label` is treated as HTML so the caller can render an underlined
// shortcut letter (e.g. `Prev (<u>P</u>)`). Labels are hard-coded
// constants in this module — no untrusted input — so innerHTML is
// safe here.
function mkBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = label;
  b.addEventListener('click', onClick);
  return b;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
