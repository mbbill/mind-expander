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
}

export interface TourPlayer {
  start(tour: ResolvedTour): void;
  stop(): void;
  isPlaying(): boolean;
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
  };

  const start = (tour: ResolvedTour): void => {
    active = tour;
    stepIndex = -1;
    goto(0);
  };

  const stop = (): void => {
    active = null;
    stepIndex = 0;
    bubble?.hide();
    bubble = null;
    hooks.onStop();
  };

  const isPlaying = (): boolean => active !== null;

  return { start, stop, isPlaying };
}
