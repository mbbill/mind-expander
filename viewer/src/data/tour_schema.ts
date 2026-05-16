// Wire shape of a resolved tour as the server pushes it down /api/tour-events.
// Mirrors src/tour.rs's `ResolvedTour` — keep these two in sync.

export type ElementKind = 'module' | 'type' | 'field' | 'method' | 'function';

export interface ResolvedRef {
  readonly id: string;
  readonly kind: ElementKind;
}

/** What the bubble should point at on this stage. Set by the server
 *  during ingestion. */
export type StepFocus = 'none' | 'element' | 'arrow';

export interface ResolvedStep {
  readonly say: string;
  readonly refs: readonly ResolvedRef[];
  readonly focus: StepFocus;
}

export interface ResolvedTour {
  readonly tour_id: string;
  readonly title?: string;
  readonly subject?: ResolvedRef;
  readonly steps: readonly ResolvedStep[];
}
