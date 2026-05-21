// Top-center "new tour" button. Tiny pill that surfaces when at
// least one tour has been received. Click → opens the tour-steps
// panel and starts the most recently received tour.
//
// Replaces the previous larger bar that owned the tour dropdown +
// play/stop. Those affordances moved to `tour_panel.ts` (dropdown)
// and the bubble's own Esc / Next controls (stop / advance).

import type { ResolvedTour } from '../data/tour_schema.ts';

export interface TourBarOptions {
  /** Click handler — caller opens the panel and starts the tour. */
  readonly onActivate: (tour: ResolvedTour) => void;
}

export interface TourBar {
  /** Append a newly arrived tour. Selects it as the "latest" target
   *  for the next click and re-triggers the new-tour halo. */
  addTour(tour: ResolvedTour): void;
}

export function createTourBar(opts: TourBarOptions): TourBar {
  const root = document.createElement('button');
  root.id = 'tour-bar';
  root.type = 'button';
  root.hidden = true;
  root.title = 'Open tour panel and start the newest tour';
  document.body.appendChild(root);

  let latest: ResolvedTour | null = null;

  const renderText = (): void => {
    root.textContent = latest === null ? '' : `▶ new tour: ${latest.title ?? '(no title)'}`;
  };

  root.addEventListener('click', () => {
    if (latest === null) return;
    // The halo is a "fresh arrival" alert; once the user clicks
    // we've acknowledged it. Drop the class until the next tour
    // arrives, when addTour will re-trigger it.
    root.classList.remove('is-new');
    opts.onActivate(latest);
  });

  const addTour = (tour: ResolvedTour): void => {
    latest = tour;
    root.hidden = false;
    renderText();
    // Reset the animation so a second arrival is visually distinct
    // from "halo's been running for a while". The remove → reflow
    // → add toggle restarts the keyframes from frame 0.
    root.classList.remove('is-new');
    // eslint-disable-next-line no-void
    void root.offsetWidth;
    root.classList.add('is-new');
  };

  return { addTour };
}
