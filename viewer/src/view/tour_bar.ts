// Top-center tour bar. Shows the active tour's title with a dropdown
// to pick another received tour, plus a play/stop toggle.

import type { ResolvedTour } from '../data/tour_schema.ts';

export interface TourBarOptions {
  readonly onPlay: (tour: ResolvedTour) => void;
  readonly onStop: () => void;
}

export interface TourBar {
  /** Append a newly arrived tour and select it as active. Triggers
   *  the rainbow halo to draw attention. */
  addTour(tour: ResolvedTour): void;
  /** Switch external state to playing/stopped (e.g. when the bubble's
   *  Stop button fires). */
  setPlaying(playing: boolean): void;
}

export function createTourBar(opts: TourBarOptions): TourBar {
  const root = document.createElement('div');
  root.id = 'tour-bar';
  root.hidden = true;

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'tour-bar-title';
  title.title = 'Choose tour';
  root.appendChild(title);

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'tour-bar-play';
  // Inline SVG icons (set in renderPlay below). SVG geometry is
  // perfectly centerable inside the circular button, unlike the
  // unicode ▶/■ glyphs whose metrics drift relative to the bbox.
  // The play triangle's vertices are chosen so its centroid lands
  // at the viewBox centre, which looks balanced to the eye.
  root.appendChild(playBtn);

  document.body.appendChild(root);

  // Dropdown menu element, lazily created.
  let menu: HTMLDivElement | null = null;
  const closeMenu = (): void => {
    if (menu !== null) {
      menu.remove();
      menu = null;
      document.removeEventListener('mousedown', onDocDown, true);
    }
  };
  const onDocDown = (e: MouseEvent): void => {
    if (menu === null) return;
    if (menu.contains(e.target as Node)) return;
    if (title.contains(e.target as Node)) return;
    closeMenu();
  };
  const openMenu = (): void => {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'tour-bar-menu';
    for (const t of tours) {
      const row = document.createElement('div');
      row.className = 'tour-bar-menu-row';
      if (t.tour_id === selected?.tour_id) row.classList.add('is-active');
      row.textContent = `${t.title ?? '(no title)'} · ${t.tour_id}`;
      row.addEventListener('click', () => {
        select(t);
        closeMenu();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const r = title.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.addEventListener('mousedown', onDocDown, true);
  };
  title.addEventListener('click', () => {
    if (menu !== null) closeMenu();
    else openMenu();
  });

  const tours: ResolvedTour[] = [];
  let selected: ResolvedTour | null = null;
  let playing = false;

  const renderTitle = (): void => {
    if (selected === null) {
      title.textContent = '(no tour)';
    } else {
      title.textContent = `${selected.title ?? '(no title)'} ▾`;
    }
  };

  // SVG icons drawn inside a 12×12 viewBox. Triangle vertices are
  // chosen so the geometric centroid (mean of vertices) lands at
  // (6, 6) — the viewBox centre — which reads as visually centred
  // even though a triangle's bounding box is always biased toward
  // the point. Solving (2a + b)/3 = 6 with a = 3.5 gives b = 11,
  // so the two base vertices sit at x = 3.5 and the apex at x = 11.
  const PLAY_SVG =
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2 L11 6 L3.5 10 Z"/></svg>';
  const STOP_SVG =
    '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8"/></svg>';

  const renderPlay = (): void => {
    playBtn.innerHTML = playing ? STOP_SVG : PLAY_SVG;
    playBtn.classList.toggle('is-playing', playing);
  };

  const select = (t: ResolvedTour): void => {
    selected = t;
    renderTitle();
  };

  playBtn.addEventListener('click', () => {
    if (selected === null) return;
    if (playing) {
      opts.onStop();
    } else {
      // The halo is a "new tour arrived" alert — once the user hits
      // play, they've acknowledged it, so drop the class. Subsequent
      // tour arrivals (addTour) re-add it.
      root.classList.remove('is-new');
      opts.onPlay(selected);
    }
  });

  const addTour = (tour: ResolvedTour): void => {
    tours.push(tour);
    selected = tour;
    root.hidden = false;
    renderTitle();
    renderPlay();
    // Rainbow halo: loops infinitely while `is-new` is set, so the
    // bar keeps a soft alert glow continuously after a tour arrives.
    // We don't auto-remove the class — the animation just keeps
    // going. The remove → reflow → add toggle is still useful when
    // a SECOND tour arrives mid-cycle: it resets the animation to
    // its start frame so the user sees a clear "something new
    // arrived" cue.
    root.classList.remove('is-new');
    // eslint-disable-next-line no-void
    void root.offsetWidth;
    root.classList.add('is-new');
  };

  const setPlaying = (next: boolean): void => {
    playing = next;
    renderPlay();
  };

  return { addTour, setPlaying };
}
