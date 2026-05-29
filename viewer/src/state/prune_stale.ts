// Stale-id pruning for the live-reload rebuild. When the server swaps in a
// fresh facts snapshot, any expanded / selected / shown id that no longer
// exists in the NEW facts must be removed from the persistent UI-state sets
// BEFORE the redraw.
//
// This is for memory hygiene + correctness of derived state, NOT crash
// avoidance: the layout/geometry read `state.isExpanded` over the NEW tree
// and the `*Shown` sets via `.has()` over NEW rows, so a stale id is inert
// at draw time. But a stale ghost-node id can keep a phantom re-export arrow
// "shown", a stale module id keeps focus-mode expansions for a deleted
// module, and a vanished selected element must clear the code panel. The
// predicates below match the EXACT key space of each set (see the per-set
// comments) so a survivor is never dropped and a genuine orphan never lingers.

import type { FunctionCallIndex } from '../analysis/calls.ts';
import { type ModuleNode, type TreeNode, methodBucketId } from '../analysis/module_tree.ts';
import { fieldId } from '../data/ids.ts';
import { type ElementKind, type SpanIndex, lookupSpan } from '../data/spans.ts';
import { signatureExpansionId } from '../layout/geometry.ts';
import { ROW_ARROW_KEY_SEP } from '../analysis/layout_model.ts';
import { type FieldKeyKind, parseFieldKey } from '../view/tree.ts';
import type { ViewState } from './view_state.ts';

/** The set of ids that the NEW facts can legitimately hold expanded. Closed
 *  over every namespace ViewState mixes together: module ids (crate roots +
 *  nested modules), real type ids, function-group + ghost pseudo-type ids
 *  (both are TreeNode `type` nodes), per-type method-bucket ids, and the
 *  `sig::<fn>` signature-expansion ids. Focus mode injects module ids into
 *  ViewState, so EVERY new module id must be present or a focus-expanded
 *  deleted module would never be collapsed. */
export interface IdUniverse {
  /** All expandable ids in the new tree (modules + types + pseudo-types +
   *  method buckets + signature ids). */
  readonly expandable: ReadonlySet<string>;
  /** Subset of type-node ids that are synthesized ghost re-export nodes —
   *  the key space of `ghostArrowsShown`. */
  readonly ghostNodeIds: ReadonlySet<string>;
}

/** Walk the freshly-built staticRoot and enumerate every id that the new
 *  facts can legitimately hold expanded or shown. */
export function buildIdUniverse(root: ModuleNode): IdUniverse {
  const expandable = new Set<string>();
  const ghostNodeIds = new Set<string>();

  const walk = (node: TreeNode): void => {
    expandable.add(node.id);
    if (node.kind === 'module') {
      for (const child of node.children) walk(child);
      return;
    }
    // TypeNode: real type, function-group, or ghost. All addressable by id.
    if (node.isGhost === true) ghostNodeIds.add(node.id);
    // Method buckets are expandable rows keyed by `${type}::__methods_<bucket>`.
    for (const bucket of node.methodBuckets) {
      expandable.add(methodBucketId(node.fullPath, bucket.bucket));
    }
    // Signature-expansion ids for every callable row (method or free fn).
    for (const bucket of node.methodBuckets) {
      for (const m of bucket.methods) {
        expandable.add(signatureExpansionId(`${node.fullPath}::${m.name}`));
      }
    }
    for (const fn of node.functions) {
      expandable.add(signatureExpansionId(fn.fullPath));
    }
  };
  walk(root);

  return { expandable, ghostNodeIds };
}

export interface PruneArgs {
  readonly universe: IdUniverse;
  readonly spanIndex: SpanIndex;
  readonly calls: FunctionCallIndex;
  readonly viewState: ViewState;
  readonly selectedFields: Set<string>;
  readonly incomingCallTargetsShown: Set<string>;
  readonly specificCallArrowsShown: Set<string>;
  readonly ghostArrowsShown: Set<string>;
  /** Currently selected diagram/code element, or null. */
  readonly selectedElementId: string | null;
  readonly selectedElementKind: ElementKind | null;
}

export interface PruneResult {
  /** True when the selected element still resolves in the new facts. The
   *  caller clears the code panel + diagram selection when this is false. */
  readonly selectedStillPresent: boolean;
}

/** Remove every stale id from the persistent UI-state sets in place, using
 *  the precise key space of each set. Run AFTER spanIndex / calls /
 *  staticRoot have been rebuilt — member-existence validation reads the
 *  NEW spanIndex.forward and the NEW calls.rowByFunction. */
export function pruneStaleState(args: PruneArgs): PruneResult {
  const {
    universe,
    spanIndex,
    calls,
    viewState,
    selectedFields,
    incomingCallTargetsShown,
    specificCallArrowsShown,
    ghostArrowsShown,
    selectedElementId,
    selectedElementKind,
  } = args;

  // (a) Expansion: ViewState has no batch-delete, so collapse per id. Snapshot
  //     the ids first — collapsing mutates the underlying set we'd be iterating.
  for (const id of [...viewState.expandedIds()]) {
    if (!universe.expandable.has(id)) viewState.collapse(id);
  }

  // (b) Field/member selection: key is `${typePath}\x1F${kind}\x1F${name}`
  //     where the name is the ROW name (not the disambiguated method id).
  //     Drop iff the member no longer exists in the rebuilt facts.
  for (const key of [...selectedFields]) {
    const { typePath, fieldName, kind } = parseFieldKey(key);
    if (!memberStillPresent(spanIndex, calls, typePath, fieldName, kind)) {
      selectedFields.delete(key);
    }
  }

  // (c) Per-edge call arrows: key is `${caller}\x1F${callee}`. Drop iff the
  //     CALLER endpoint is gone from the new call index. The callee may be
  //     external/unresolved (revealSpecificEdge tolerates that), so we only
  //     require the caller row to exist.
  for (const key of [...specificCallArrowsShown]) {
    const sep = key.indexOf(ROW_ARROW_KEY_SEP);
    const caller = sep === -1 ? key : key.slice(0, sep);
    if (!calls.rowByFunction.has(caller)) specificCallArrowsShown.delete(key);
  }

  // (d) Incoming-call targets: key is a functionFullPath. Drop iff it's no
  //     longer a callable row.
  for (const fnPath of [...incomingCallTargetsShown]) {
    if (!calls.rowByFunction.has(fnPath)) incomingCallTargetsShown.delete(fnPath);
  }

  // (e) Ghost re-export arrows: key is a synthetic ghost NODE id. Drop iff
  //     that ghost node is absent from the new tree.
  for (const ghostId of [...ghostArrowsShown]) {
    if (!universe.ghostNodeIds.has(ghostId)) ghostArrowsShown.delete(ghostId);
  }

  const selectedStillPresent =
    selectedElementId !== null &&
    selectedElementKind !== null &&
    lookupSpan(spanIndex, selectedElementId, selectedElementKind) !== null;

  return { selectedStillPresent };
}

/** A selected member survives iff its row still exists in the new facts.
 *  Field rows key on `fieldId(typePath, name)` in the span index. Method /
 *  function rows are matched by ROW NAME against the call index's per-type
 *  rows — NOT by reconstructing `${typePath}::${name}`, because a trait
 *  method's span-index id carries an `@Trait` disambiguation suffix the
 *  selection key never has. `rowName` is exactly the key the selection stores. */
function memberStillPresent(
  spanIndex: SpanIndex,
  calls: FunctionCallIndex,
  typePath: string,
  fieldName: string,
  kind: FieldKeyKind,
): boolean {
  if (kind === 'field') {
    return lookupSpan(spanIndex, fieldId(typePath, fieldName), 'field') !== null;
  }
  // method / function row: present iff some callable row on this type matches
  // both the row name and the row kind.
  const rows = calls.rowsByType.get(typePath);
  if (rows === undefined) return false;
  return rows.some((r) => r.rowName === fieldName && r.rowKind === kind);
}
