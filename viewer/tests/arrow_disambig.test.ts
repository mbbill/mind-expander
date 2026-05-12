import { describe, expect, it } from 'vitest';
import type { ArrowHit } from '../src/analysis/arrow_hit.ts';
import type { Arrow } from '../src/analysis/layout_model.ts';
import {
  arrowDisambigRowModel,
  arrowDisambigViewportAction,
  groupArrowHits,
} from '../src/view/arrow_disambig.ts';

// Real `qualifiedTypePath` keeps the crate prefix on the display path
// (e.g., `sf-nano-core::vm::instance::Instance`). Crate stripping is
// the disambig's own responsibility — it compares each endpoint's
// crate against the row's anchor crate and strips only when they
// match, so cross-crate hops stay visible.
const qualifiedTypePath = (fullPath: string): string => {
  const labels: Record<string, string> = {
    'sf-nano-core::vm::store::__fn_pub': 'sf-nano-core::vm::store',
  };
  return labels[fullPath] ?? fullPath;
};

describe('arrowDisambigRowModel', () => {
  it('renders each ambiguous call as source and target endpoint labels', () => {
    const hits = [
      hit(
        callArrow(
          'sf-nano-core::vm::instance::Instance',
          'from_module_with_registry',
          'sf-nano-core::vm::store::Store',
          'global_mut',
        ),
      ),
      hit(
        callArrow(
          'sf-nano-core::vm::instance::Instance',
          'set_global',
          'sf-nano-core::vm::store::Store',
          'global_mut',
        ),
      ),
    ];

    expect(arrowDisambigRowModel(hits[0] as ArrowHit, qualifiedTypePath)).toEqual({
      source: {
        prefix: 'vm::instance::',
        main: 'Instance.from_module_with_registry()',
      },
      target: {
        prefix: 'vm::store::',
        main: 'Store.global_mut()',
      },
    });
  });

  it('keeps the crate prefix when the target lives in a different crate', () => {
    // Anchor = source's crate (`sf-nano-cli`). The target is in
    // `sf-nano-core`, so the cross-crate hop must stay visible on the
    // target prefix even though the source's own crate is stripped.
    const model = arrowDisambigRowModel(
      hit(
        callArrow(
          'sf-nano-cli::cmd::Runner',
          'invoke',
          'sf-nano-core::vm::store::Store',
          'global_mut',
        ),
      ),
      qualifiedTypePath,
    );

    expect(model.source).toEqual({
      prefix: 'cmd::',
      main: 'Runner.invoke()',
    });
    // Cross-crate target: the crate name comes back as its own segment
    // so the popup can paint it in the accent color, separate from the
    // dim module prefix and the main label.
    expect(model.target).toEqual({
      crateName: 'sf-nano-core',
      prefix: 'vm::store::',
      main: 'Store.global_mut()',
    });
  });

  it('renders module-level functions as module path plus function name', () => {
    const model = arrowDisambigRowModel(
      hit(
        callArrow(
          'sf-nano-core::vm::store::__fn_pub',
          'register_gc_ref',
          'sf-nano-core::vm::store::Store',
          'global_mut',
          'function',
        ),
      ),
      qualifiedTypePath,
    );

    expect(model.source).toEqual({
      prefix: 'vm::store::',
      main: 'register_gc_ref()',
    });
  });
});

describe('groupArrowHits', () => {
  it('groups by source when one source fans out to several targets', () => {
    const h1 = hit(callArrow('Caller', 'fn', 'TargetA', 'a'));
    const h2 = hit(callArrow('Caller', 'fn', 'TargetB', 'b'));
    const h3 = hit(callArrow('Caller', 'fn', 'TargetC', 'c'));

    const groups = groupArrowHits([h1, h2, h3]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('by-source');
    expect(groups[0]?.shared).toBe(h1);
    expect(groups[0]?.others).toEqual([h1, h2, h3]);
  });

  it('groups by target when several sources merge into one target', () => {
    const h1 = hit(callArrow('CallerA', 'fa', 'Target', 'sink'));
    const h2 = hit(callArrow('CallerB', 'fb', 'Target', 'sink'));
    const h3 = hit(callArrow('CallerC', 'fc', 'Target', 'sink'));

    const groups = groupArrowHits([h1, h2, h3]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('by-target');
    expect(groups[0]?.others).toEqual([h1, h2, h3]);
  });

  it('keeps singletons as one-hit groups when nothing is shared', () => {
    const h1 = hit(callArrow('A', 'fa', 'X', 'x'));
    const h2 = hit(callArrow('B', 'fb', 'Y', 'y'));

    const groups = groupArrowHits([h1, h2]);
    // S == T == 2, tie → group by source; each source is distinct so the
    // groups are singletons that render like a flat list.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === 'by-source')).toBe(true);
    expect(groups.every((g) => g.others.length === 1)).toBe(true);
  });

  it('handles partial sharing by producing the right group count', () => {
    // Two hits share source A; one hit has a distinct source. S=2, T=3.
    // S<T → group by source. Result: one multi-target group for A plus a
    // singleton for B.
    const h1 = hit(callArrow('A', 'fa', 'X', 'x'));
    const h2 = hit(callArrow('A', 'fa', 'Y', 'y'));
    const h3 = hit(callArrow('B', 'fb', 'Z', 'z'));

    const groups = groupArrowHits([h1, h2, h3]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.others).toEqual([h1, h2]);
    expect(groups[1]?.others).toEqual([h3]);
  });

  it('returns no groups for an empty hit list', () => {
    expect(groupArrowHits([])).toEqual([]);
  });
});

describe('arrowDisambigViewportAction', () => {
  it('moves the popup by screen-space pan delta when only translation changes', () => {
    expect(arrowDisambigViewportAction({ x: 10, y: 20, k: 1 }, { x: 16, y: 17, k: 1 })).toEqual({
      kind: 'move',
      dx: 6,
      dy: -3,
    });
  });

  it('hides the popup when zoom scale changes', () => {
    expect(arrowDisambigViewportAction({ x: 10, y: 20, k: 1 }, { x: 16, y: 17, k: 1.1 })).toEqual({
      kind: 'hide',
    });
  });
});

function hit(arrow: Arrow, zone: ArrowHit['zone'] = 'source'): ArrowHit {
  return { arrow, zone, distance: 0 };
}

function callArrow(
  fromTypeId: string,
  fromFieldName: string,
  toTypeId: string,
  toFieldName: string,
  fromRowKind: Arrow['fromRowKind'] = 'method',
): Arrow {
  return {
    waypoints: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    fromTypeId,
    fromFieldName,
    fromRowKind,
    toTypeId,
    toFieldName,
    toRowKind: 'method',
    kind: 'call',
    driftClass: 'at_lca',
  };
}
