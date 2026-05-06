// Disambiguation popover for arrow-click navigation. Shown only when a
// click lands within hit-tolerance of multiple arrows; the user picks
// which arrow they meant and we navigate to its corresponding endpoint.
// Single-hit clicks bypass this entirely.
//
// Lives in screen-space (fixed-position) so it doesn't move with pan/zoom
// — pan/zoom dismisses it (the click is ambiguous in a different sense
// once the canvas has moved under it).

import type { ArrowHit } from '../analysis/arrow_hit.ts';

const MARGIN = 8;

export interface ArrowDisambigShowArgs {
  readonly hits: readonly ArrowHit[];
  /** Anchor in screen coords — typically where the user clicked. The panel
   *  is placed near here, kept inside the viewport. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Resolve a type fullPath to a short display label. The popover only
   *  has type ids on the arrows themselves; main.ts owns the type-info
   *  map. */
  readonly typeLabel: (fullPath: string) => string;
}

export interface ArrowDisambig {
  show: (args: ArrowDisambigShowArgs) => void;
  hide: () => void;
}

export function createArrowDisambig(opts: {
  /** Called when the user picks one row. The caller drives navigation
   *  using the arrow's endpoints + zone (head → source, body → target).
   *  `anchor` is the original click position that opened the popover —
   *  forwarded so the navigator can place the chosen endpoint under
   *  that spot, matching the direct-click behaviour. */
  onPick: (hit: ArrowHit, anchor: { x: number; y: number }) => void;
}): ArrowDisambig {
  const root = document.createElement('div');
  root.id = 'arrow-disambig';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '22';
  root.style.display = 'none';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'arrow-disambig-panel';
  panel.style.pointerEvents = 'auto';
  panel.style.position = 'absolute';
  root.appendChild(panel);

  // Click outside the panel dismisses. Listen on the root (which covers
  // the whole viewport) so any backdrop click counts; the panel itself
  // re-enables pointer-events so clicks land on rows.
  root.addEventListener('click', (e) => {
    if (e.target === root) hide();
  });
  // ESC also dismisses, matching the familiar popover pattern.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && root.style.display !== 'none') hide();
  };
  document.addEventListener('keydown', onKey);

  const hide = (): void => {
    root.style.display = 'none';
  };

  const show = (args: ArrowDisambigShowArgs): void => {
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'header';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${args.hits.length} arrows here — pick one`;
    header.appendChild(title);
    panel.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'arrow-list';
    panel.appendChild(list);

    for (const hit of args.hits) {
      const row = document.createElement('li');
      row.className = 'arrow-row';
      row.tabIndex = 0;

      // Show what clicking this row will DO. Body → "go to target",
      // head → "go to source". The arrow + the destination label are
      // the dominant glyph; the full from/to line below is the
      // explanation in smaller type.
      const action = document.createElement('div');
      action.className = 'action';
      const dest =
        hit.zone === 'head'
          ? args.typeLabel(hit.arrow.fromTypeId)
          : args.typeLabel(hit.arrow.toTypeId);
      const dirGlyph = hit.zone === 'head' ? '←' : '→';
      action.textContent = `${dirGlyph} ${dest}`;
      row.appendChild(action);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const fromLabel = args.typeLabel(hit.arrow.fromTypeId);
      // Row-kind suffix on the source name: methods get trailing
      // `()`, ghosts (re-exports) get `↪` to mark "this is a re-export
      // edge." Without this, two arrows with the same `(typePath,
      // name, toTypePath)` shape — e.g. struct field `module` and
      // method `module()` both pointing at `ModuleInst` — render as
      // identical rows in the disambig popover.
      const sourceSuffix = hit.arrow.fromRowKind === 'method' ? '()' : '';
      const fieldChunk = hit.arrow.fromFieldName
        ? `.${hit.arrow.fromFieldName}${sourceSuffix}`
        : '';
      const kindHint =
        hit.arrow.kind === 'reexport' ? ' ↪' : hit.arrow.kind === 'method' ? ' ⋯' : '';
      const toLabel = args.typeLabel(hit.arrow.toTypeId);
      meta.textContent = `${fromLabel}${fieldChunk}${kindHint} → ${toLabel}`;
      row.appendChild(meta);

      const onActivate = (): void => {
        opts.onPick(hit, { x: args.anchorX, y: args.anchorY });
        hide();
      };
      row.addEventListener('click', onActivate);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      });

      list.appendChild(row);
    }

    // Show first so we can measure, then clamp inside the viewport.
    root.style.display = 'block';
    panel.style.left = '0px';
    panel.style.top = '0px';
    const rect = panel.getBoundingClientRect();
    let left = args.anchorX + 12;
    let top = args.anchorY + 12;
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, args.anchorX - rect.width - 12);
    }
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, args.anchorY - rect.height - 12);
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    // Focus the first row so keyboard users can act immediately.
    const first = list.querySelector<HTMLElement>('li.arrow-row');
    first?.focus();
  };

  return { show, hide };
}
