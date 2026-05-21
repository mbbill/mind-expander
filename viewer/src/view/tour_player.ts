// Drives an active tour through its steps. Owns the bubble; the
// caller passes in two callbacks: `applyStep` runs the per-step
// diagram actions (select / pan / sync code), and `anchorFor` returns
// a screen-rect for the bubble to point at on the current step.

import type { ResolvedStep, ResolvedTour } from '../data/tour_schema.ts';
import { type TourBubble, createTourBubble } from './tour_bubble.ts';

export interface PlayerHooks {
  /** Called on enter (or re-enter via prev/next) for the active
   *  step. Should update the diagram side: select, pan, sync code. */
  readonly applyStep: (step: ResolvedStep) => Promise<void> | void;
  /** Returns a CALLABLE that the bubble polls each frame for the
   *  screen-rect of the focused element. Live evaluation lets the
   *  pointer track the target while the user pans / zooms the
   *  canvas. The closure should return null when the target isn't
   *  in the DOM (e.g. its module hasn't been expanded yet). */
  readonly anchorFor: (step: ResolvedStep) => () => DOMRect | null;
  /** Player has fully stopped (last step + next, or user clicked
   *  Stop). The caller flips its UI back to "not playing". */
  readonly onStop: () => void;
  /** Returns a rect the bubble should avoid covering (e.g. the
   *  open code panel). Optional — when omitted, the bubble only
   *  considers the window edges. */
  readonly getAvoidRect?: () => DOMRect | null;
  /** Fires after a step transition finishes — both the diagram
   *  side-effects in `applyStep` AND the bubble render are
   *  scheduled. The tour-steps panel uses this to update which
   *  row is highlighted as "current". Fires on start (step 0),
   *  every Next / Prev / gotoStep, and is silent on stop (the
   *  panel watches `onStop` for that). */
  readonly onStepChange?: (index: number) => void;
}

export interface TourPlayer {
  /** Start (or restart) the given tour. `startStep` defaults to 0;
   *  pass a non-zero value to begin at a specific step — used by
   *  the panel when a user clicks a row in a tour that wasn't
   *  already playing. */
  start(tour: ResolvedTour, startStep?: number): void;
  stop(): void;
  isPlaying(): boolean;
  /** Jump to step `i` (0-based). No-op outside `[0, steps.length)`
   *  or when no tour is active. Same code path as Next / Prev —
   *  the panel's row-click handler calls this. */
  gotoStep(i: number): void;
  /** Active tour, or null when nothing is playing. */
  activeTour(): ResolvedTour | null;
  /** Current 0-based step index, or -1 when nothing is playing. */
  currentStepIndex(): number;
}

export function createTourPlayer(hooks: PlayerHooks): TourPlayer {
  let active: ResolvedTour | null = null;
  let stepIndex = 0;
  let bubble: TourBubble | null = null;

  const ensureBubble = (): TourBubble => {
    if (bubble !== null) return bubble;
    bubble = createTourBubble({
      onPrev: () => goto(stepIndex - 1),
      onNext: () => {
        if (active === null) return;
        if (stepIndex >= active.steps.length - 1) stop();
        else goto(stepIndex + 1);
      },
      onStop: stop,
      getAvoidRect: hooks.getAvoidRect,
    });
    return bubble;
  };

  const renderBubble = (): void => {
    if (active === null) return;
    const step = active.steps[stepIndex];
    if (step === undefined) return;
    ensureBubble().show({
      say: step.say,
      getAnchor: hooks.anchorFor(step),
      stepIndex,
      stepCount: active.steps.length,
      hasPrev: stepIndex > 0,
      hasNext: stepIndex < active.steps.length - 1,
    });
  };

  const goto = (i: number): void => {
    if (active === null) return;
    if (i < 0 || i >= active.steps.length) return;
    stepIndex = i;
    const step = active.steps[stepIndex]!;
    const maybe = hooks.applyStep(step);
    if (maybe instanceof Promise) {
      maybe.then(renderBubble).catch((err) => {
        console.error('[tour] applyStep failed', err);
        renderBubble();
      });
    } else {
      // Defer the bubble render to the next frame so the DOM has had
      // a chance to apply the diagram-side updates (transforms,
      // expansions). Anchors read from getBoundingClientRect need
      // the rendered state.
      requestAnimationFrame(renderBubble);
    }
    // Notify subscribers synchronously — the panel's highlight
    // doesn't need to wait for the bubble render, and reading
    // `currentStepIndex()` from a step-change handler should
    // return the new index immediately.
    hooks.onStepChange?.(stepIndex);
  };

  const start = (tour: ResolvedTour, startStep = 0): void => {
    active = tour;
    // Goto reads `active` and applies the step; no equality check
    // on the prior stepIndex, so jumping straight to `startStep`
    // works (the panel uses this when a user clicks an arbitrary
    // row in a tour that isn't currently playing).
    goto(startStep);
  };

  const stop = (): void => {
    active = null;
    stepIndex = 0;
    bubble?.hide();
    bubble = null;
    hooks.onStop();
  };

  const isPlaying = (): boolean => active !== null;
  const gotoStep = (i: number): void => goto(i);
  const activeTour = (): ResolvedTour | null => active;
  const currentStepIndex = (): number => (active === null ? -1 : stepIndex);

  return { start, stop, isPlaying, gotoStep, activeTour, currentStepIndex };
}
