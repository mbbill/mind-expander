// Corner notification shown when a tour arrives via /api/tour-events.
// First-cut UX: title + step count + Play / Dismiss. Play stubs to a
// console.log for now; the full playback engine comes later.

import type { ResolvedTour } from '../data/tour_schema.ts';

interface TourNotifyOptions {
  readonly onPlay: (tour: ResolvedTour) => void;
}

interface TourNotify {
  show(tour: ResolvedTour): void;
  hide(): void;
}

export function createTourNotification(opts: TourNotifyOptions): TourNotify {
  let root: HTMLElement | null = null;

  const hide = (): void => {
    if (root !== null) {
      root.remove();
      root = null;
    }
  };

  const show = (tour: ResolvedTour): void => {
    hide();
    root = document.createElement('div');
    root.className = 'tour-notification';

    const title = document.createElement('div');
    title.className = 'tour-notification-title';
    title.textContent = 'Tour received';

    const subtitle = document.createElement('div');
    subtitle.className = 'tour-notification-subtitle';
    subtitle.textContent = tour.title ?? '(no title)';

    const meta = document.createElement('div');
    meta.className = 'tour-notification-meta';
    meta.textContent = `${tour.steps.length} step${tour.steps.length === 1 ? '' : 's'} · ${tour.tour_id}`;

    const actions = document.createElement('div');
    actions.className = 'tour-notification-actions';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'tour-notification-play';
    playBtn.textContent = 'Play';
    playBtn.addEventListener('click', () => {
      opts.onPlay(tour);
      hide();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'tour-notification-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', hide);

    actions.appendChild(playBtn);
    actions.appendChild(dismissBtn);

    root.appendChild(title);
    root.appendChild(subtitle);
    root.appendChild(meta);
    root.appendChild(actions);
    document.body.appendChild(root);
  };

  return { show, hide };
}
