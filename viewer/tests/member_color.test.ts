// Source-snapshot tests for the new ownership-flavor coloring on type
// members. The previous drift-text-color helpers (memberColorForDriftClass,
// memberRowColorForArrows, callableRowColor) were deleted with the drift
// color removal; their semantics moved to:
//   - Field name color: borrowFlavor(tyText) → orange / violet / red / grey
//   - Callable name color: selfKind → orange / violet / grey
//   - Drift signal: a colored circle to the left of the name (no dot for
//     canonical placements)
//   - Locality signal: `→` glyph after `(..)` with locality color
//
// These tests pin the wiring at the source level so future refactors can't
// silently drop a channel of information.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function treeSource(): string {
  return readFileSync(new URL('../src/view/tree.ts', import.meta.url), 'utf8');
}

describe('field rows are colored by borrow flavor of their type, not drift', () => {
  const source = treeSource();

  it('drives field name color from borrowFlavor of tyText', () => {
    expect(source).toContain("f.kind === 'field'");
    expect(source).toContain('borrowFlavorColor(borrowFlavor(f.tyText))');
  });

  it('does not export the deleted drift-color helpers', () => {
    expect(source).not.toContain('memberColorForDriftClass');
    expect(source).not.toContain('memberRowColorForArrows');
    expect(source).not.toContain('callableRowColor');
  });

  it('keeps the four-flavor palette wired', () => {
    // Move uses the existing neutral grey (no separate hex).
    expect(source).toContain('COLOR_BORROW_MOVE = COLOR_FIELD_TY');
    expect(source).toContain("#c2410c"); // shared → orange-700
    expect(source).toContain("#7c3aed"); // mut → violet-600
    expect(source).toContain("#dc2626"); // raw → red-600
  });
});

describe('callable rows are colored by self receiver flavor', () => {
  const source = treeSource();

  it('drives callable name color from selfKindFlavor(f.selfKind)', () => {
    expect(source).toContain('selfKindFlavor(f.selfKind)');
  });

  it('maps self_kind tokens to the right flavor', () => {
    // The intent is encoded as a switch; pin the case bodies so a refactor
    // can't silently flip the mapping.
    expect(source).toMatch(/case 'ref':\s*return 'shared'/);
    expect(source).toMatch(/case 'ref_mut':\s*return 'mut'/);
  });
});

describe('drift signal lives on a dot, not the name color', () => {
  const source = treeSource();

  it('renders a circle.drift-dot adjacent to drifted field rows', () => {
    expect(source).toContain("'drift-dot'");
    expect(source).toContain('driftDotColor(f.memberDriftClass)');
  });

  it('uses no dot for canonical placements', () => {
    // The driftDotColor switch returns null on at_lca / within_budget by
    // falling through to the default. Both names must be absent from any
    // case arm body that returns a color.
    expect(source).toMatch(/case 'drift_below':\s*return COLOR_MEMBER_DRIFT_BELOW/);
    expect(source).toMatch(/case 'drift_above':[\s\S]*?case 'drift_sideways':\s*return COLOR_ARROW_HARD/);
    expect(source).toMatch(/default:\s*return null/);
  });
});

describe('locality signal lives on a `→` glyph after the callable name', () => {
  const source = treeSource();

  it('renders a text.locality-glyph for callable rows with outgoing calls', () => {
    expect(source).toContain("'locality-glyph'");
    expect(source).toContain('f.hasOutgoingCalls');
    expect(source).toContain('localityGlyphColor(f)');
  });

  it('colors the glyph by call locality', () => {
    // Blue for cross-module, orange for unresolved, grey for local-only.
    expect(source).toMatch(/hasExternalCalls === true.*return '#2563eb'/);
    expect(source).toMatch(/hasUnresolvedCalls === true.*return '#f97316'/);
    expect(source).toMatch(/return COLOR_FIELD_TY/);
  });

  it('the `→` glyph is the click target for arrow selection on callables', () => {
    // Clicking the row name expands the signature; clicking the `→`
    // glyph toggles the call arrows. Pinning the wiring at the source
    // level so future refactors can't silently flip the affordance.
    expect(source).toMatch(/localityGlyph\.on\(\s*'click'/);
    expect(source).toMatch(/onSelectField\(d\.fullPath, f\.name, kindForClick\)/);
  });
});

describe('hover on the call markers grows them and shows a count badge', () => {
  const source = treeSource();

  it('the left incoming marker grows on hover and reveals an incoming-count badge', () => {
    // Both wiring (the badge class + the count source) and the size
    // animation are pinned so a future refactor can't silently drop one
    // of the affordances.
    expect(source).toContain("'incoming-count-badge'");
    expect(source).toContain('f.incomingCallRefs');
    expect(source).toMatch(
      /incomingMarker[\s\S]*?\.on\(\s*'mouseenter'[\s\S]*?CALL_MARKER_HOVER_FONT_SIZE/,
    );
    expect(source).toMatch(
      /incomingMarker[\s\S]*?\.on\(\s*'mouseleave'[\s\S]*?INCOMING_CALL_MARKER_FONT_SIZE/,
    );
  });

  it('the right locality glyph grows on hover and reveals an outgoing-count badge', () => {
    expect(source).toContain("'locality-count-badge'");
    expect(source).toContain('f.callRefs');
    expect(source).toMatch(
      /localityGlyph[\s\S]*?\.on\(\s*'mouseenter'[\s\S]*?CALL_MARKER_HOVER_FONT_SIZE/,
    );
    expect(source).toMatch(
      /localityGlyph[\s\S]*?\.on\(\s*'mouseleave'[\s\S]*?INCOMING_CALL_MARKER_FONT_SIZE/,
    );
  });

  it('count badges are pointer-events: none so they cannot steal hover from the glyph', () => {
    // Each badge insertion sets pointer-events: none. Without this, the
    // badge would catch the cursor as it expands into view, the marker
    // would lose hover state, and the badge would immediately hide
    // again — a flicker loop.
    const badgeBlocks = source.match(/incoming-count-badge[\s\S]{0,400}/g) ?? [];
    expect(badgeBlocks.some((block) => block.includes("'pointer-events', 'none'"))).toBe(true);
    const localityBadgeBlocks = source.match(/locality-count-badge[\s\S]{0,400}/g) ?? [];
    expect(localityBadgeBlocks.some((b) => b.includes("'pointer-events', 'none'"))).toBe(true);
  });
});

describe('callable click handlers are split between name and `→`', () => {
  const source = treeSource();

  it('callable name click ONLY toggles signature expansion', () => {
    // Each affordance owns exactly one effect: name → expand args,
    // `→` glyph → toggle arrow. No dual-effect side-channel.
    expect(source).toMatch(
      /isCallable && f\.functionFullPath !== null[\s\S]*?opts\.onToggleSignature\(f\.functionFullPath\)/,
    );
    // Field name clicks remain selection toggles — fields have no
    // signature to expand.
    expect(source).toMatch(
      /f\.kind === 'field'[\s\S]*?opts\.onSelectField\(d\.fullPath, f\.name, 'field'\)/,
    );
    // The callable branch should not also call onSelectField on a name
    // click — that would re-introduce the side-effect we just removed.
    const callableBranch = source.match(
      /isCallable && f\.functionFullPath !== null[\s\S]*?(?=\} else if|\}\s*\};)/,
    )?.[0];
    expect(callableBranch).toBeDefined();
    expect(callableBranch).not.toContain('onSelectField(d.fullPath, f.name, callableKind)');
  });

  it('the (..) glyph is gone', () => {
    expect(source).not.toContain("'signature-toggle'");
    expect(source).not.toContain("'(..)'");
  });
});
