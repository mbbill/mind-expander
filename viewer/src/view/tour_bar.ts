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
  playBtn.textContent = '▶';
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

  const renderPlay = (): void => {
    playBtn.textContent = playing ? '■' : '▶';
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
      opts.onPlay(selected);
    }
  });

  const addTour = (tour: ResolvedTour): void => {
    tours.push(tour);
    selected = tour;
    root.hidden = false;
    renderTitle();
    renderPlay();
    // Rainbow halo: restart by toggling the class.
    root.classList.remove('is-new');
    // eslint-disable-next-line no-void
    void root.offsetWidth;
    root.classList.add('is-new');
    window.setTimeout(() => root.classList.remove('is-new'), 4000);
  };

  const setPlaying = (next: boolean): void => {
    playing = next;
    renderPlay();
  };

  return { addTour, setPlaying };
}
