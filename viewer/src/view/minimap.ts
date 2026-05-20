import { select } from 'd3';
import type { Layout } from '../analysis/layout_model.ts';
import { colorForVisibility } from './encoding.ts';
import type { ZoomLayers } from './zoom.ts';

const W = 180;
const H = 132;
const PAD = 8;
const MIN_TYPE_W = 2;
const MIN_TYPE_H = 2;

const DIFF_ADD = '#56C271';
const DIFF_DEL = '#FF6B6B';

export interface MinimapOptions {
  /** When provided (unified-diff mode), color each type-box by its
   *  bar state so the minimap mirrors the diagram's add/del signal
   *  at a glance. `add`/`split` → green, `del` → red. Anything not
   *  in the map falls back to the regular visibility color. */
  readonly typeBarStateById?: ReadonlyMap<string, 'add' | 'del' | 'split'>;
}

export interface Minimap {
  readonly update: (layout: Layout | null) => void;
}

export function createMinimap(
  root: HTMLElement,
  scrollEl: HTMLElement,
  layers: ZoomLayers,
  opts: MinimapOptions = {},
): Minimap {
  const svg = select(root)
    .select<SVGSVGElement>('svg')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // Gradient used by `split` type-boxes: green top half, red bottom
  // half (hard stop at 50%). Mirrors the diagram's two-rect bar so
  // the user sees the same green-over-red signal at minimap scale.
  if (svg.select<SVGDefsElement>('defs.minimap-defs').empty()) {
    const defs = svg.append<SVGDefsElement>('defs').attr('class', 'minimap-defs');
    const grad = defs
      .append('linearGradient')
      .attr('id', 'minimap-split')
      .attr('x1', '0')
      .attr('y1', '0')
      .attr('x2', '0')
      .attr('y2', '1');
    grad.append('stop').attr('offset', '50%').attr('stop-color', DIFF_ADD);
    grad.append('stop').attr('offset', '50%').attr('stop-color', DIFF_DEL);
  }

  const bandG = ensureGroup(svg, 'minimap-bands');
  const typeG = ensureGroup(svg, 'minimap-types');
  const viewport = svg
    .selectAll<SVGRectElement, null>('rect.minimap-viewport')
    .data([null])
    .join('rect')
    .attr('class', 'minimap-viewport');

  let currentLayout: Layout | null = null;
  let scale = 1;
  let ox = PAD;
  let oy = PAD;

  const render = (): void => {
    if (!currentLayout || currentLayout.totalWidth <= 0 || currentLayout.totalHeight <= 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const layout = currentLayout;
    scale = Math.min((W - 2 * PAD) / layout.totalWidth, (H - 2 * PAD) / layout.totalHeight);
    const contentW = layout.totalWidth * scale;
    const contentH = layout.totalHeight * scale;
    ox = (W - contentW) / 2;
    oy = (H - contentH) / 2;
    const x = (v: number): number => ox + v * scale;
    const y = (v: number): number => oy + v * scale;

    bandG
      .selectAll<SVGRectElement, Layout['modules'][number]>('rect')
      .data(layout.modules, (d) => d.id)
      .join('rect')
      .attr('x', ox)
      .attr('y', (d) => y(d.y))
      .attr('width', contentW)
      .attr('height', (d) => Math.max(1, d.bandHeight * scale))
      .attr('fill', (_, i) => (i % 2 === 0 ? '#f8fafc' : '#eef2f7'));

    typeG
      .selectAll<SVGRectElement, Layout['types'][number]>('rect')
      .data(layout.types, (d) => d.id)
      .join('rect')
      .attr('x', (d) => x(d.x))
      .attr('y', (d) => y(d.y - d.height / 2))
      .attr('width', (d) => Math.max(MIN_TYPE_W, d.width * scale))
      .attr('height', (d) => Math.max(MIN_TYPE_H, d.height * scale))
      .attr('fill', (d) => {
        // In unified-diff mode, the minimap's job is to surface
        // where the diff is, not to reproduce the LCA color palette
        // (which carries no signal in diff mode and only competes
        // with the green/red). Diff-tagged entities get the bright
        // diff colors; `split` uses the half-green/half-red gradient
        // so it doesn't read as "just added". Unchanged is a single
        // neutral grey. In single-snapshot mode (no
        // typeBarStateById), the LCA palette is the right signal
        // and we keep it as before.
        if (opts.typeBarStateById !== undefined) {
          const s = opts.typeBarStateById.get(d.fullPath);
          if (s === 'add') return DIFF_ADD;
          if (s === 'del') return DIFF_DEL;
          if (s === 'split') return 'url(#minimap-split)';
          return '#cbd5e1'; // slate-300 — unchanged
        }
        return colorForVisibility(d.visibility);
      })
      .attr('opacity', (d) => {
        // Side-tagged entities are louder (full opacity) so they
        // pop in the minimap; everything else stays at the previous
        // soft opacity so unchanged structure doesn't compete.
        const s = opts.typeBarStateById?.get(d.fullPath);
        if (s === 'add' || s === 'del' || s === 'split') return 0.95;
        return d.typeKind === 'function_group' ? 0.25 : 0.4;
      });

    renderViewport(layout);
  };

  const renderViewport = (layout: Layout): void => {
    // Visible-data-range math. With native vertical scroll the d3.zoom
    // transform's `t.y` already mirrors `-scrollTop`, so the vertical
    // visible band is `[-t.y/k, (-t.y + scrollViewportH)/k]`. The
    // viewport SIZE (what the user sees on screen) is the scroll
    // container's clientHeight, not the SVG's — the SVG is now sized
    // to the full content extent so its clientHeight ≈ totalHeight * k.
    const t = layers.getTransform();
    const viewW = scrollEl.clientWidth;
    const viewH = scrollEl.clientHeight;
    const vx0 = clamp(-t.x / t.k, 0, layout.totalWidth);
    const vy0 = clamp(-t.y / t.k, 0, layout.totalHeight);
    const vx1 = clamp((viewW - t.x) / t.k, 0, layout.totalWidth);
    const vy1 = clamp((viewH - t.y) / t.k, 0, layout.totalHeight);
    viewport
      .attr('x', ox + Math.min(vx0, vx1) * scale)
      .attr('y', oy + Math.min(vy0, vy1) * scale)
      .attr('width', Math.max(2, Math.abs(vx1 - vx0) * scale))
      .attr('height', Math.max(2, Math.abs(vy1 - vy0) * scale));
  };

  const panFromPointer = (event: PointerEvent): void => {
    const layout = currentLayout;
    if (!layout) return;
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const dataX = clamp((mx - ox) / scale, 0, layout.totalWidth);
    const dataY = clamp((my - oy) / scale, 0, layout.totalHeight);
    layers.centerOn(dataX, dataY, false);
  };

  const node = svg.node();
  if (node) {
    let dragging = false;
    node.addEventListener('pointerdown', (event) => {
      dragging = true;
      node.setPointerCapture(event.pointerId);
      panFromPointer(event);
      event.preventDefault();
      event.stopPropagation();
    });
    node.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      panFromPointer(event);
      event.preventDefault();
      event.stopPropagation();
    });
    const stopDrag = (event: PointerEvent): void => {
      dragging = false;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };
    node.addEventListener('pointerup', stopDrag);
    node.addEventListener('pointercancel', stopDrag);
  }

  return {
    update: (layout) => {
      currentLayout = layout;
      render();
    },
  };
}

function ensureGroup(
  svg: ReturnType<typeof select<SVGSVGElement, unknown>>,
  cls: string,
): ReturnType<typeof select<SVGGElement, unknown>> {
  const existing = svg.select<SVGGElement>(`g.${cls}`);
  if (!existing.empty()) return existing;
  return svg.append('g').attr('class', cls);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
