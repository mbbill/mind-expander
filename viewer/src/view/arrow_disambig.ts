// Disambiguation popover for arrow-click navigation. Shown only when a
// click lands within hit-tolerance of multiple arrows; the user picks
// which arrow they meant and we navigate to its corresponding endpoint.
// Single-hit clicks bypass this entirely.
//
// Lives in screen-space (fixed-position). Plain clicks dismiss it, panning
// moves it by the same screen delta as the canvas, and zooming dismisses it
// because the click tolerance/geometry no longer represents the same target.

import type { ArrowHit } from '../analysis/arrow_hit.ts';
import type { ArrowEndpoint } from './arrow_navigation.ts';

const MARGIN = 8;
const TRANSFORM_EPSILON = 0.000001;

export interface ArrowDisambigViewportTransform {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export type ArrowDisambigViewportAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'hide' }
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number };

export interface ArrowDisambigShowArgs {
  readonly hits: readonly ArrowHit[];
  /** Anchor in screen coords — typically where the user clicked. The panel
   *  is placed near here, kept inside the viewport. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Resolve a type fullPath to its display path. Real types include their
   *  module path + type label; synthetic function groups resolve to the
   *  containing module path. main.ts owns that type-info map. */
  readonly qualifiedTypePath: (fullPath: string) => string;
}

export interface ArrowDisambig {
  show: (args: ArrowDisambigShowArgs) => void;
  hide: () => void;
  moveBy: (dx: number, dy: number) => void;
}

export function createArrowDisambig(opts: {
  /** Called when the user picks one endpoint of one arrow. The caller owns
   *  resolving that endpoint against the current layout and deciding where
   *  the viewport goes. `endpoint` tells the caller which direction the
   *  user wants to travel: 'source' = navigate to the caller, 'target' =
   *  navigate to the callee. `anchor` is the screen point where the user
   *  activated this row — pan target lands here so the chosen endpoint
   *  appears under the cursor (or keyboard focus) that just selected it. */
  onPick: (
    hit: ArrowHit,
    endpoint: ArrowEndpoint,
    anchor: { readonly x: number; readonly y: number },
  ) => void;
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

  let panelLeft = 0;
  let panelTop = 0;

  // A completed click outside the panel dismisses. Use document capture
  // because the root is pointer-transparent so canvas clicks pass through
  // to the SVG, and because pointerdown would incorrectly dismiss a pan
  // before the canvas can move with the popup.
  const onOutsideClick = (e: MouseEvent): void => {
    if (root.style.display === 'none') return;
    if (e.button !== 0) return;
    const target = e.target;
    if (target instanceof Node && panel.contains(target)) return;
    hide();
  };
  document.addEventListener('click', onOutsideClick, true);
  // ESC also dismisses, matching the familiar popover pattern.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && root.style.display !== 'none') hide();
  };
  document.addEventListener('keydown', onKey);

  const hide = (): void => {
    root.style.display = 'none';
  };

  const moveBy = (dx: number, dy: number): void => {
    if (root.style.display === 'none') return;
    panelLeft += dx;
    panelTop += dy;
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;
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

    // Group hits so a shared source (or shared target) only appears once
    // with the fanned-out other endpoints listed under it. The pure
    // grouping decision lives in `groupArrowHits` so it can be tested
    // without DOM.
    const onPickHit = (
      hit: ArrowHit,
      endpoint: ArrowEndpoint,
      anchor: { readonly x: number; readonly y: number },
    ): void => {
      opts.onPick(hit, endpoint, anchor);
      hide();
    };
    for (const group of groupArrowHits(args.hits)) {
      const row = document.createElement('li');
      row.className = 'arrow-row';
      row.appendChild(arrowDisambigGroupElement(group, args.qualifiedTypePath, onPickHit));
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
    panelLeft = left;
    panelTop = top;
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${panelTop}px`;

    // Focus the first endpoint so keyboard users can act immediately.
    const first = list.querySelector<HTMLElement>('.arrow-endpoint');
    first?.focus();
  };

  return { show, hide, moveBy };
}

export function arrowDisambigViewportAction(
  previous: ArrowDisambigViewportTransform,
  next: ArrowDisambigViewportTransform,
): ArrowDisambigViewportAction {
  if (Math.abs(next.k - previous.k) > TRANSFORM_EPSILON) return { kind: 'hide' };
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  if (Math.abs(dx) <= TRANSFORM_EPSILON && Math.abs(dy) <= TRANSFORM_EPSILON) {
    return { kind: 'none' };
  }
  return { kind: 'move', dx, dy };
}

export interface ArrowEndpointLabel {
  readonly prefix: string;
  readonly main: string;
}

export interface ArrowDisambigRowModel {
  readonly source: ArrowEndpointLabel;
  readonly target: ArrowEndpointLabel;
}

/**
 * A visual group of hits that share an endpoint. `by-source` means many
 * arrows fan out from one source; `by-target` means many arrows merge into
 * one target. The shared side is carried as a single representative hit
 * (any hit in the group has the right source/target identity for nav).
 */
export type ArrowDisambigGroup =
  | { readonly kind: 'by-source'; readonly shared: ArrowHit; readonly others: readonly ArrowHit[] }
  | { readonly kind: 'by-target'; readonly shared: ArrowHit; readonly others: readonly ArrowHit[] };

/**
 * Decide how to lay out `hits` in the popup. Picks whichever side compresses
 * more — fewer distinct sources than targets ⇒ group by source; the inverse
 * ⇒ group by target; tie ⇒ group by source. Hits within a group keep their
 * input order so the popup matches the order routes were ranked by distance.
 *
 * The returned groups may overlap when sources AND targets repeat in
 * different combinations; in that case the chosen axis still produces the
 * smaller group count. Mixed patterns (some sharing, some not) naturally
 * render as a few multi-item groups plus singletons.
 */
export function groupArrowHits(hits: readonly ArrowHit[]): readonly ArrowDisambigGroup[] {
  if (hits.length === 0) return [];
  const distinctSources = countDistinctEndpoints(hits, sourceKey);
  const distinctTargets = countDistinctEndpoints(hits, targetKey);
  const groupBySource = distinctSources <= distinctTargets;
  return groupBySource ? groupByKey(hits, sourceKey, 'by-source') : groupByKey(hits, targetKey, 'by-target');
}

function groupByKey(
  hits: readonly ArrowHit[],
  key: (hit: ArrowHit) => string,
  kind: 'by-source' | 'by-target',
): readonly ArrowDisambigGroup[] {
  const buckets = new Map<string, ArrowHit[]>();
  const order: string[] = [];
  for (const hit of hits) {
    const k = key(hit);
    let bucket = buckets.get(k);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(k, bucket);
      order.push(k);
    }
    bucket.push(hit);
  }
  return order.map((k) => {
    const bucket = buckets.get(k) ?? [];
    const shared = bucket[0] as ArrowHit;
    return { kind, shared, others: bucket };
  });
}

function countDistinctEndpoints(
  hits: readonly ArrowHit[],
  key: (hit: ArrowHit) => string,
): number {
  const seen = new Set<string>();
  for (const hit of hits) seen.add(key(hit));
  return seen.size;
}

function sourceKey(hit: ArrowHit): string {
  return `${hit.arrow.fromTypeId}\x1F${hit.arrow.fromFieldName}\x1F${hit.arrow.fromRowKind}`;
}

function targetKey(hit: ArrowHit): string {
  return `${hit.arrow.toTypeId}\x1F${hit.arrow.toFieldName ?? ''}\x1F${hit.arrow.toRowKind ?? ''}`;
}

export function arrowDisambigRowModel(
  hit: ArrowHit,
  qualifiedTypePath: (fullPath: string) => string,
): ArrowDisambigRowModel {
  return {
    source: endpointLabelParts(
      qualifiedTypePath(hit.arrow.fromTypeId),
      hit.arrow.fromFieldName,
      hit.arrow.fromRowKind,
    ),
    target: endpointLabelParts(
      qualifiedTypePath(hit.arrow.toTypeId),
      hit.arrow.toFieldName,
      hit.arrow.toRowKind,
    ),
  };
}

function arrowDisambigGroupElement(
  group: ArrowDisambigGroup,
  qualifiedTypePath: (fullPath: string) => string,
  onPickHit: (
    hit: ArrowHit,
    endpoint: ArrowEndpoint,
    anchor: { readonly x: number; readonly y: number },
  ) => void,
): HTMLElement {
  const route = document.createElement('div');
  route.className = 'arrow-route';
  if (group.kind === 'by-source') {
    // One source on top, one indented `-> target` per arrow underneath.
    // Clicking the source navigates to the source row (any hit in the
    // group is fine — they all share that endpoint).
    const sourceLabel = endpointLabelParts(
      qualifiedTypePath(group.shared.arrow.fromTypeId),
      group.shared.arrow.fromFieldName,
      group.shared.arrow.fromRowKind,
    );
    route.appendChild(
      endpointLineElement('source', sourceLabel, (endpoint, anchor) =>
        onPickHit(group.shared, endpoint, anchor),
      ),
    );
    for (const hit of group.others) {
      const targetLabel = endpointLabelParts(
        qualifiedTypePath(hit.arrow.toTypeId),
        hit.arrow.toFieldName,
        hit.arrow.toRowKind,
      );
      route.appendChild(
        endpointLineElement('target', targetLabel, (endpoint, anchor) =>
          onPickHit(hit, endpoint, anchor),
        ),
      );
    }
  } else {
    // Many sources on top, one `-> target` at the bottom. Mirror layout of
    // the by-source case so "many → one" reads as a visual funnel.
    for (const hit of group.others) {
      const sourceLabel = endpointLabelParts(
        qualifiedTypePath(hit.arrow.fromTypeId),
        hit.arrow.fromFieldName,
        hit.arrow.fromRowKind,
      );
      route.appendChild(
        endpointLineElement('source', sourceLabel, (endpoint, anchor) =>
          onPickHit(hit, endpoint, anchor),
        ),
      );
    }
    const targetLabel = endpointLabelParts(
      qualifiedTypePath(group.shared.arrow.toTypeId),
      group.shared.arrow.toFieldName,
      group.shared.arrow.toRowKind,
    );
    route.appendChild(
      endpointLineElement('target', targetLabel, (endpoint, anchor) =>
        onPickHit(group.shared, endpoint, anchor),
      ),
    );
  }
  return route;
}

function endpointLineElement(
  kind: ArrowEndpoint,
  label: ArrowEndpointLabel,
  onPick: (endpoint: ArrowEndpoint, anchor: { readonly x: number; readonly y: number }) => void,
): HTMLElement {
  const line = document.createElement('div');
  line.className = `arrow-endpoint ${kind}`;
  line.tabIndex = 0;
  line.setAttribute('role', 'button');
  // Only the target line gets the `->` glyph. The arrow's direction is
  // always source → target, so showing a glyph on the source line would
  // duplicate the same direction and visually suggest a separate `<-`
  // arrow. Source reads as the origin label; target reads as "-> dest".
  if (kind === 'target') {
    const glyph = document.createElement('span');
    glyph.className = 'route-arrow';
    glyph.textContent = '→';
    line.appendChild(glyph);
  }
  if (label.prefix !== '') {
    const prefix = document.createElement('span');
    prefix.className = 'path-prefix';
    prefix.textContent = label.prefix;
    line.appendChild(prefix);
  }
  const main = document.createElement('span');
  main.className = 'path-main';
  main.textContent = label.main;
  line.appendChild(main);
  line.addEventListener('click', (e) => {
    // The chosen endpoint pans to where the click actually happened, so
    // the target appears under the user's cursor (which is necessarily
    // over this row — they just clicked it). Using the original arrow
    // click anchor would jump the target to wherever the user *first*
    // clicked to open the popup, far from where they're looking now.
    onPick(kind, { x: e.clientX, y: e.clientY });
  });
  line.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // Keyboard activation has no cursor — anchor to the focused row's
    // own centre instead, keeping the "appear where I'm looking" feel.
    const rect = line.getBoundingClientRect();
    onPick(kind, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  });
  return line;
}

function endpointLabelParts(
  typePath: string,
  rowName: string | undefined,
  rowKind: 'field' | 'method' | 'function' | undefined,
): ArrowEndpointLabel {
  if (rowKind === 'function') {
    return splitQualifiedName(endpointPath(typePath, '::', rowName, rowKind));
  }
  return splitQualifiedName(endpointPath(typePath, '.', rowName, rowKind));
}

function endpointPath(
  typePath: string,
  separator: '::' | '.',
  rowName: string | undefined,
  rowKind: 'field' | 'method' | 'function' | undefined,
): string {
  const base = stripFunctionGroupSuffix(typePath);
  if (rowName === undefined || rowName === '') return base;
  const suffix = `${rowName}${rowKind === 'method' || rowKind === 'function' ? '()' : ''}`;
  if (base === '') return suffix;
  return `${base}${separator}${suffix}`;
}

function stripFunctionGroupSuffix(typePath: string): string {
  const marker = '::__fn_';
  const markerIndex = typePath.indexOf(marker);
  if (markerIndex === -1) return typePath;
  return typePath.slice(0, markerIndex);
}

function splitQualifiedName(path: string): ArrowEndpointLabel {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex !== -1) {
    const typePath = path.slice(0, dotIndex);
    const member = path.slice(dotIndex);
    const typeSplit = splitRustPath(typePath);
    return { prefix: typeSplit.prefix, main: `${typeSplit.main}${member}` };
  }

  return splitRustPath(path);
}

function splitRustPath(path: string): ArrowEndpointLabel {
  const segments = path.split('::');
  const main = segments.pop() ?? path;
  if (segments.length === 0) return { prefix: '', main };
  return { prefix: `${segments.join('::')}::`, main };
}
