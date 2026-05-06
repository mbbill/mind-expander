// Ownership graph extracted from edges, scoped to a single crate. Pure.
//
// "Ownership" = `kind=owns` plus a structural via (struct_field, union_field,
// enum_variant_payload). Function-param/return owns are call-relations, not
// structural composition; excluded by design (matches handover discipline).
//
// Two outputs:
//   • OwnershipIndex: per-type list of owned target full_paths (for arrow drawing later).
//   • depthMap: Kahn's longest-path depth per type. Cycles are tolerated by
//     treating in-cycle nodes as if they had no remaining prerequisites — they
//     fall to depth 0.

import type { Facts } from '../data/schema.ts';
import { type DriftIndex, isCanonicalTarget } from './drift.ts';

export interface OwnershipIndex {
  /** Per type's full_path → list of owned target full_paths (deduped, intra-crate only). */
  readonly owns: ReadonlyMap<string, readonly string[]>;
  /** Reverse: per target → list of owners. */
  readonly ownedBy: ReadonlyMap<string, readonly string[]>;
  /** Per (type full_path, field name) → list of owned target full_paths. Used for per-field arrow drawing. */
  readonly fieldTargets: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Per (type full_path, method name) → list of referenced target
   *  full_paths from the method's params and return type. Includes
   *  owned + borrowed + indirection kinds (a borrow from a method is
   *  still a "this method uses that type" relationship the user wants
   *  to see). Drives method-row arrows in the layout. */
  readonly methodTargets: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

const STRUCTURAL_VIAS: readonly string[] = ['struct_field', 'union_field', 'enum_variant_payload'];
const METHOD_VIAS: readonly string[] = ['fn_param', 'fn_return'];
// Edge kinds that count as "this method references that type" for
// method-row arrows. We include borrows because a method that takes a
// `&Foo` param is semantically using `Foo` — the user wants to see that
// arrow. Field-level fieldTargets stays narrower (owns only) because
// fields encode structural composition; this asymmetry is intentional.
const METHOD_REFERENCE_KINDS: readonly string[] = [
  'owns',
  'borrows_immut',
  'borrows_mut',
  'indirection',
];

export function buildOwnershipIndex(facts: Facts, crateName: string): OwnershipIndex {
  const inCrate = (fullPath: string): boolean => fullPath.startsWith(`${crateName}::`);

  const owns = new Map<string, string[]>();
  const ownedBy = new Map<string, string[]>();
  const fieldTargets = new Map<string, Map<string, string[]>>();
  const methodTargets = new Map<string, Map<string, string[]>>();

  for (const e of facts.edges) {
    if (!inCrate(e.from) || !inCrate(e.to)) continue;
    if (e.from === e.to) continue; // ignore self-loops at index level too

    // Structural ownership index — drives per-field arrows + depth.
    if (e.kind === 'owns' && STRUCTURAL_VIAS.includes(e.via)) {
      pushUnique(owns, e.from, e.to);
      pushUnique(ownedBy, e.to, e.from);
      const fieldName = parseFieldName(e.origin);
      if (fieldName !== undefined) {
        let perType = fieldTargets.get(e.from);
        if (!perType) {
          perType = new Map();
          fieldTargets.set(e.from, perType);
        }
        pushUnique(perType, fieldName, e.to);
      }
      continue;
    }

    // Method-row references — drives the new per-method arrows. We key
    // by (typeFullPath, methodName); the extractor sets `from` to the
    // owning type's full_path for methods, so this lookup matches the
    // way the renderer keys arrow sources.
    if (METHOD_VIAS.includes(e.via) && METHOD_REFERENCE_KINDS.includes(e.kind)) {
      const methodName = parseMethodName(e.origin);
      if (methodName !== undefined) {
        let perType = methodTargets.get(e.from);
        if (!perType) {
          perType = new Map();
          methodTargets.set(e.from, perType);
        }
        pushUnique(perType, methodName, e.to);
      }
    }
  }

  return {
    owns: owns as ReadonlyMap<string, readonly string[]>,
    ownedBy: ownedBy as ReadonlyMap<string, readonly string[]>,
    fieldTargets: fieldTargets as ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
    methodTargets: methodTargets as ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  };
}

// Origin grammar:
//   "field {name}"                  → struct_field, union_field
//   "field {Variant}"               → enum_variant_payload (unit/bare variant)
//   "field {Variant}::{payload}"    → enum_variant_payload (named or tuple payload)
// The whole tail is the key — it matches `TypeFacts.fields[i].name` exactly,
// which for enum payload variants is `Variant::payload` (or `Variant::0` for
// tuple variants). Stripping at `::` collapsed all payload edges of a tuple
// variant to one bucket and broke per-row arrow lookup in the renderer.
function parseFieldName(origin: string): string | undefined {
  const PREFIX = 'field ';
  if (!origin.startsWith(PREFIX)) return undefined;
  return origin.slice(PREFIX.length);
}

// Origin grammar for method-derived edges, mirroring `emit_edges_from_fn`
// in the extractor:
//   "fn {name} param {paramName}"   → fn_param edge
//   "fn {name} -> ret"              → fn_return edge
// We extract just `{name}` — the method's own name — and key
// methodTargets by (typeFullPath, methodName). Param names aren't
// surfaced here because methods aren't sub-rowed by parameter; one
// method-row aggregates every type it touches via params + return.
function parseMethodName(origin: string): string | undefined {
  const PREFIX = 'fn ';
  if (!origin.startsWith(PREFIX)) return undefined;
  // The substring after `fn ` and before the next space is the method
  // name. Both grammars (`param ...` and `-> ret`) split on the first
  // space after that.
  const tail = origin.slice(PREFIX.length);
  const sp = tail.indexOf(' ');
  return sp < 0 ? tail : tail.slice(0, sp);
}

/**
 * Longest-path depth via Kahn's algorithm on the ownership DAG.
 *
 * Cycles in the ownership graph are broken with a DFS-based back-edge
 * detection pass: any edge from `u` to an ancestor `v` (still on the DFS
 * stack when we see the edge) is treated as a back-edge and excluded from
 * the depth computation. Without this, cycle members would all stay at
 * depth 0 and end up in the same x-column when rendered, producing
 * backward arrow segments (caught by the arrow-direction invariant tests).
 *
 * If `drift` is provided, edges to non-canonical targets (drift_*) are
 * skipped: drift'd types receive no depth contribution from their owners and
 * stay at depth 0. Their outgoing edges still propagate normally to canonical
 * targets, since canonical-edge classification is per target, not per source.
 *
 * @param typeIds  Universe of types to assign depth to (full_paths). Types
 *                 with no edges get depth 0.
 */
export function computeOwnershipDepth(
  index: OwnershipIndex,
  typeIds: Iterable<string>,
  drift?: DriftIndex,
): ReadonlyMap<string, number> {
  const allowed = drift
    ? (target: string) => isCanonicalTarget(target, drift)
    : (_target: string) => true;

  // Materialize the universe so we can filter ownership relations to only
  // those whose endpoints are in scope. Without this, a type whose owner
  // lies outside the universe (e.g. a test-module type that's been
  // excluded from `typeIds`) would have its remaining count never reach
  // zero, leaving the type — and everything downstream — at depth 0.
  const universe = new Set<string>();
  for (const id of typeIds) universe.add(id);

  const back = detectBackEdges(index);
  const isBack = (from: string, to: string): boolean => back.has(backEdgeKey(from, to));

  const depth = new Map<string, number>();
  const remaining = new Map<string, number>(); // unresolved canonical owners per type

  for (const id of universe) {
    depth.set(id, 0);
    if (allowed(id)) {
      // Count owners that are (a) in the universe and (b) not back-edges.
      let n = 0;
      for (const o of index.ownedBy.get(id) ?? []) {
        if (!universe.has(o)) continue;
        if (!isBack(o, id)) n++;
      }
      remaining.set(id, n);
    } else {
      // Non-canonical target: no incoming edges count, depth stays 0.
      remaining.set(id, 0);
    }
  }

  const queue: string[] = [];
  for (const [id, n] of remaining) {
    if (n === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const u = queue.shift();
    if (u === undefined) break;
    const owned = index.owns.get(u);
    if (!owned) continue;
    const du = depth.get(u) ?? 0;
    for (const v of owned) {
      if (!universe.has(v)) continue;
      if (isBack(u, v)) continue;
      if (!allowed(v)) continue;
      const nextDepth = du + 1;
      const cur = depth.get(v);
      if (cur !== undefined && nextDepth > cur) depth.set(v, nextDepth);
      const r = (remaining.get(v) ?? 0) - 1;
      remaining.set(v, r);
      if (r === 0) queue.push(v);
    }
  }

  return depth;
}

/**
 * DFS-based back-edge identification. An edge `u → v` is a back-edge if
 * `v` is currently on the DFS stack (in-progress) when `u` reaches it.
 * Iterative implementation so deep ownership graphs don't blow the JS
 * call stack.
 *
 * Returns a set of `${from}\0${to}` keys (null-byte separator avoids
 * collisions with `::` that legitimately appears in type paths).
 */
function detectBackEdges(index: OwnershipIndex): Set<string> {
  const back = new Set<string>();
  const state = new Map<string, 'in-progress' | 'done'>();

  // All nodes that appear as owner or owned.
  const all = new Set<string>();
  for (const k of index.owns.keys()) all.add(k);
  for (const arr of index.owns.values()) for (const v of arr) all.add(v);

  // Start DFS from roots first (nodes with no incoming ownership edges).
  // This makes "natural" forward edges follow ownership flow, so the
  // back-edges we identify are the actual *back-references* in cycles
  // rather than arbitrary forward edges that happen to be visited last.
  // Without this, e.g. CfgBlock→CfgEdge could be marked as a back-edge
  // (if DFS starts at CfgEdge), inverting the layout's column order.
  const roots: string[] = [];
  const nonRoots: string[] = [];
  for (const node of all) {
    const inDeg = index.ownedBy.get(node)?.length ?? 0;
    if (inDeg === 0) roots.push(node);
    else nonRoots.push(node);
  }
  const orderedStarts = [...roots, ...nonRoots];

  for (const start of orderedStarts) {
    if (state.has(start)) continue;
    state.set(start, 'in-progress');
    type Frame = { node: string; iter: Iterator<string> };
    const stack: Frame[] = [
      { node: start, iter: (index.owns.get(start) ?? [])[Symbol.iterator]() },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as Frame;
      const next = top.iter.next();
      if (next.done) {
        state.set(top.node, 'done');
        stack.pop();
        continue;
      }
      const v = next.value;
      const s = state.get(v);
      if (s === 'in-progress') {
        back.add(backEdgeKey(top.node, v));
      } else if (s === undefined) {
        state.set(v, 'in-progress');
        stack.push({ node: v, iter: (index.owns.get(v) ?? [])[Symbol.iterator]() });
      }
      // else 'done' → forward / cross edge, not a back-edge.
    }
  }
  return back;
}

function backEdgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  if (!arr.includes(value)) arr.push(value);
}
