import { describe, expect, it } from 'vitest';
import {
  MIN_TYPE_BOX_W,
  TYPE_EXPAND_ARROW_CLOSED,
  TYPE_EXPAND_ARROW_FONT_SCALE,
  TYPE_EXPAND_ARROW_GAP,
  TYPE_EXPAND_ARROW_OPEN,
  TYPE_LABEL_FONT_SCALE,
  TYPE_LABEL_X,
  measureTypeHeaderMetrics,
} from '../src/analysis/layout_metrics.ts';

const measure = (text: string): number => (text === 'Type' ? 120 : text.length * 10);

describe('layout metrics', () => {
  it('does not reserve invisible trailing width for non-expandable type headers', () => {
    const metrics = measureTypeHeaderMetrics('Type', false, measure);
    const labelRight = TYPE_LABEL_X + measure('Type') * TYPE_LABEL_FONT_SCALE;

    expect(metrics.width).toBe(Math.max(MIN_TYPE_BOX_W, labelRight));
    expect(metrics.arrowX).toBeNull();
    expect(metrics.hitWidth).toBe(metrics.width);
  });

  it('keeps expandable type header hit width equal to the visible box', () => {
    const metrics = measureTypeHeaderMetrics('Type', true, measure);
    const labelRight = TYPE_LABEL_X + measure('Type') * TYPE_LABEL_FONT_SCALE;
    const arrowX = labelRight + TYPE_EXPAND_ARROW_GAP;
    const arrowWidth =
      Math.max(measure(TYPE_EXPAND_ARROW_CLOSED), measure(TYPE_EXPAND_ARROW_OPEN)) *
      TYPE_EXPAND_ARROW_FONT_SCALE;
    const visualWidth = Math.max(MIN_TYPE_BOX_W, arrowX + arrowWidth);

    expect(metrics.arrowX).toBe(arrowX);
    expect(metrics.width).toBe(visualWidth);
    expect(metrics.hitWidth).toBe(visualWidth);
  });
});
