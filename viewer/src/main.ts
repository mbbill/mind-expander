import { computeDrift } from './analysis/drift.ts';
import type { Layout } from './analysis/layout_model.ts';
import { type TreeNode, buildModuleTree } from './analysis/module_tree.ts';
import {
  type OwnershipIndex,
  buildOwnershipIndex,
  computeOwnershipDepth,
} from './analysis/ownership.ts';
import { FactsLoadError, loadFacts } from './data/load.ts';
import type { Facts } from './data/schema.ts';
import { buildLayout } from './layout/pipeline.ts';
import { buildPlacementLayoutPlan } from './layout/placement_plan.ts';
import { ViewState } from './state/view_state.ts';
import { anchorTranslation } from './view/anchor.ts';
import { createArrowDisambig } from './view/arrow_disambig.ts';
import { createTextMeasurer } from './view/measure.ts';
import { type Minimap, createMinimap } from './view/minimap.ts';
import { createOwnersOverlay } from './view/owners_overlay.ts';
import {
  FONT_FAMILY,
  FONT_SIZE_FIELD,
  LAYOUT_DEBUG_STORAGE_KEY,
  chainArrowsFromMany,
  fieldKey,
  layoutDebugEnabled,
  parseFieldKey,
  renderEdgeShadows,
  renderTree,
} from './view/tree.ts';
import { attachZoom } from './view/zoom.ts';

const FACTS_URL = '/data/facts.json';
const PREFERRED_CRATE = 'sf-nano-core';
const SCALE_MAX = 1.5;
// Padding factor so content doesn't kiss the viewport edge at the fit scale.
const FIT_PADDING = 0.95;
const INPUT_MODE_KEY = 'mind-expander.input-mode';
// The layout pipeline is active here. Renderer-facing data contracts live in
// `analysis/layout_model.ts`; removed algorithm files should not be
// reintroduced as compatibility shims.

type InputMode = 'mouse' | 'trackpad';

interface InputController {
  readonly defaultMode: InputMode;
  readonly getMode: () => InputMode;
  readonly setMode: (mode: InputMode) => void;
}

interface TypeInfo {
  readonly label: string;
  readonly modulePath: string;
}

interface RenderCtx {
  readonly state: ViewState;
  readonly selectedFields: ReadonlySet<string>;
  readonly ownership: OwnershipIndex;
  readonly crateName: string;
  readonly draw: () => void;
  /** Set of ids that are types (vs modules). Used to filter ViewState's
   *  expanded ids when computing the type-level focus set. */
  readonly typeIdSet: ReadonlySet<string>;
  /** Lookup: type fullPath → label + module path. Used by the owner popover
   *  so it can render owner labels even when the owner isn't currently in
   *  the rendered layout. */
  readonly typeInfo: ReadonlyMap<string, TypeInfo>;
  /** Navigate the viewport to a type by id: expand the type (and its
   *  ancestor modules), redraw, then center the viewport on its new y. */
  readonly navigateToType: (typeId: string) => void;
  /** Pan the viewport so the chosen endpoint of `arrow` lands at the
   *  screen position the user clicked. `zone === 'head'` navigates to
   *  the SOURCE end (clicked the arrowhead "to go back"); `zone === 'body'`
   *  navigates to the TARGET end. The endpoint snaps under the cursor
   *  rather than the screen centre, so the user's spatial intuition
   *  ("I clicked here") carries through the pan. */
  readonly navigateAlongArrow: (
    arrow: Layout['arrows'][number],
    zone: 'body' | 'head',
    anchor: { x: number; y: number },
  ) => void;
  /** Reset to a pristine view: clear all field selections and expansions
   *  (keeping only the crate root open), exit focus mode, and reset
   *  the zoom transform to identity. */
  readonly resetAll: () => void;
  focusMode: boolean;
  /** Global "hide methods" toggle. When true, every type's method
   *  bucket / method row stops rendering and the method-derived
   *  arrows disappear with them. Useful when you only want to inspect
   *  structural ownership and the method noise gets in the way. */
  methodsHidden: boolean;
  /** Most recent layout. Used by the F-key handler to anchor the viewport
   *  on a focused item across the focus toggle (so content doesn't fly
   *  off-screen when the layout's y-extent changes). */
  lastLayout: Layout | null;
}

let currentCtx: RenderCtx | null = null;

void main();

async function main(): Promise<void> {
  const facts = await tryLoadFacts();
  if (!facts) return;

  const select = document.querySelector<HTMLSelectElement>('#crate');
  const svg = document.querySelector<SVGSVGElement>('#tree');
  const minimapRoot = document.querySelector<HTMLElement>('#minimap');
  if (!select || !svg) {
    showError('missing required DOM elements (#crate, #tree)');
    return;
  }

  const crateNames = Object.keys(facts.crates).sort();
  for (const name of crateNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }
  const initial = crateNames.includes(PREFERRED_CRATE) ? PREFERRED_CRATE : crateNames[0];
  if (!initial) {
    showError('facts.json contains no crates');
    return;
  }
  select.value = initial;

  // Single canvas-backed measurer for the whole session — one canvas
  // element, one font binding, results memoized per string. Field names
  // recur across crates and re-renders so the cache pays back many times.
  const measureText = createTextMeasurer(`${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);

  let minimap: Minimap | null = null;
  const layers = attachZoom(svg, (t) => {
    updateScaleIndicator(t.k);
    // The owner popover is anchored in screen space to the dot's current
    // position. Notify it on every pan/zoom so it can either dismiss
    // (default) or, when pinned, follow the dot to its new spot.
    ownersOverlay.onCanvasMoved();
    // Arrow disambig is anchored to the original click point — once the
    // canvas moves it's pointing at the wrong arrows. Dismiss it.
    arrowDisambig.hide();
    // Per-band edge shadows on the frozen pane: which bands have hidden
    // type content depends on the current transform, so refresh every
    // pan/zoom event.
    if (currentCtx?.lastLayout) {
      renderEdgeShadows(layers, currentCtx.lastLayout, { x: t.x, k: t.k });
    }
    minimap?.update(currentCtx?.lastLayout ?? null);
  });
  const inputController = installInputControls(svg, layers);
  if (minimapRoot) minimap = createMinimap(minimapRoot, svg, layers);
  updateScaleIndicator(1);

  // The owner popover is a single global instance reused across crates.
  // Click-to-navigate routes through currentCtx so it picks up the right
  // per-crate state.
  const ownersOverlay = createOwnersOverlay({
    onNavigate: (typeId) => currentCtx?.navigateToType(typeId),
  });

  // Disambiguation popover for arrow clicks that fall within tolerance
  // of multiple arrows. The pick callback navigates along the chosen
  // arrow using the same logic as the single-hit case.
  const arrowDisambig = createArrowDisambig({
    onPick: (hit, anchor) => {
      currentCtx?.navigateAlongArrow(hit.arrow, hit.zone, anchor);
    },
  });

  // Toggle focus mode. Focus is a pure render-time filter: toggling it does
  // not mutate ViewState, so there's nothing to snapshot or restore.
  //
  // Anchor strategy across the toggle (always keeps something on screen):
  //   tier 1 — if the most recently selected item is in the viewport,
  //            anchor on it (keep it under the same screen y);
  //   tier 2 — otherwise, if any selected type is in the viewport, anchor
  //            on the topmost one;
  //   tier 3 — otherwise (nothing selected on screen), toggle, then
  //            center the viewport on the most recent selection's new y.
  const toggleFocus = (): void => {
    const ctx = currentCtx;
    if (!ctx) return;

    const range = layers.visibleYRange();
    const lastSelected = mostRecentSelection(ctx);

    let anchorId: string | null = null;
    let beforeY: number | null = null;

    // Tier 1
    if (lastSelected !== null) {
      const y = lookupY(ctx.lastLayout, lastSelected);
      if (y !== null && y >= range.min && y <= range.max) {
        anchorId = lastSelected;
        beforeY = y;
      }
    }
    // Tier 2: topmost on-screen expanded type.
    if (anchorId === null) {
      let bestY = Number.POSITIVE_INFINITY;
      for (const id of ctx.state.expandedIds()) {
        if (!ctx.typeIdSet.has(id)) continue;
        const y = lookupY(ctx.lastLayout, id);
        if (y === null || y < range.min || y > range.max) continue;
        if (y < bestY) {
          bestY = y;
          anchorId = id;
        }
      }
      if (anchorId !== null) beforeY = bestY;
    }

    ctx.focusMode = !ctx.focusMode;
    if (ctx.focusMode) {
      // Auto-expand the relevance modules in state so the focused subtree
      // is visible. Layout reads state directly, so this is what makes
      // module rows show their content. Expansions persist on exit.
      for (const id of computeFocus(ctx).modules) ctx.state.expand(id);
    }
    updateFocusModeIndicator(ctx.focusMode);
    ctx.draw();

    if (anchorId !== null && beforeY !== null) {
      const afterY = lookupY(ctx.lastLayout, anchorId);
      if (afterY !== null && afterY !== beforeY) {
        layers.translateBy(0, beforeY - afterY, true);
      }
      return;
    }
    // Tier 3: nothing visible. Bring the most-recent selection into view.
    if (lastSelected !== null) {
      const y = lookupY(ctx.lastLayout, lastSelected);
      if (y !== null) layers.centerOnY(y, true);
    }
  };

  // Toggle the global "hide methods" flag and redraw. The chip in the
  // corner reflects the new state visually so the user can tell at a
  // glance whether the bucket rows they expect are absent because they
  // toggled them off vs because of an empty input.
  const toggleMethods = (): void => {
    if (!currentCtx) return;
    currentCtx.methodsHidden = !currentCtx.methodsHidden;
    updateMethodsIndicator(currentCtx.methodsHidden);
    currentCtx.draw();
  };

  // Keyboard bindings: F = toggle focus, M = toggle methods visibility,
  // S = reset scale to 100%, R = reset everything (selections +
  // expansion + focus + methods + zoom/pan), ? = toggle the corner
  // legend/shortcuts dialog.
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f') toggleFocus();
    else if (e.key === 'm') toggleMethods();
    else if (e.key === 's') layers.resetScale(true);
    else if (e.key === 'r') currentCtx?.resetAll();
    else if (e.key === '?') toggleKeyhints?.();
  });

  // Foldable legend / shortcuts panel — collapsed by default. Toggle by
  // clicking the "?" chip OR pressing the `?` key. State persists in
  // sessionStorage so a reload within the same tab keeps the user's
  // preference.
  const keyhintsToggle = document.querySelector<HTMLButtonElement>('.keyhints-toggle');
  const keyhintsBody = document.querySelector<HTMLElement>('#keyhints-body');
  let toggleKeyhints: (() => void) | null = null;
  if (keyhintsToggle && keyhintsBody) {
    let expanded = sessionStorage.getItem('mind-expander.keyhints.expanded') === '1';
    const apply = (): void => {
      keyhintsToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      keyhintsBody.hidden = !expanded;
      sessionStorage.setItem('mind-expander.keyhints.expanded', expanded ? '1' : '0');
    };
    apply();
    toggleKeyhints = () => {
      expanded = !expanded;
      apply();
    };
    keyhintsToggle.addEventListener('click', toggleKeyhints);
  }

  const minimapToggle = document.querySelector<HTMLButtonElement>('.minimap-toggle');
  const minimapBody = document.querySelector<HTMLElement>('#minimap-body');
  const minimapCaret = document.querySelector<HTMLElement>('.minimap-caret');
  if (minimapToggle && minimapBody) {
    let expanded = sessionStorage.getItem('mind-expander.minimap.expanded') !== '0';
    const apply = (): void => {
      minimapToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      minimapBody.hidden = !expanded;
      if (minimapCaret) minimapCaret.textContent = expanded ? '▾' : '▸';
      sessionStorage.setItem('mind-expander.minimap.expanded', expanded ? '1' : '0');
    };
    apply();
    minimapToggle.addEventListener('click', () => {
      expanded = !expanded;
      apply();
    });
  }

  setupInputSettings(inputController);

  // Mouse bindings — clicking any keybinding chip triggers its action.
  const focusHint = document.querySelector<HTMLElement>('#hint-focus');
  if (focusHint) focusHint.addEventListener('click', () => toggleFocus());
  const methodsHint = document.querySelector<HTMLElement>('#hint-methods');
  if (methodsHint) methodsHint.addEventListener('click', () => toggleMethods());
  const scaleHint = document.querySelector<HTMLElement>('#hint-scale');
  if (scaleHint) scaleHint.addEventListener('click', () => layers.resetScale(true));
  const resetHint = document.querySelector<HTMLElement>('#hint-reset');
  if (resetHint) resetHint.addEventListener('click', () => currentCtx?.resetAll());

  // Window resize: viewport changes, so the fit-to-view minimum changes.
  // Debounce so a drag-resize doesn't fire dozens of times.
  let resizeTimer: number | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      const layout = currentCtx?.lastLayout;
      if (layout) {
        applyFitScaleExtent(svg, layers, layout);
        minimap?.update(layout);
      }
    }, 100);
  });

  const renderFor = (crateName: string): void => {
    const crate = facts.crates[crateName];
    if (!crate) {
      showError(`crate '${crateName}' not found in facts.json`);
      return;
    }
    const staticRoot = buildModuleTree(crate);
    const ownership = buildOwnershipIndex(facts, crateName);
    const allTypeIds = collectTypeIds(staticRoot);
    const typeModule = collectTypeModuleMap(staticRoot);
    const drift = computeDrift(ownership, typeModule);
    const depth = computeOwnershipDepth(ownership, allTypeIds, drift);
    const placementPlan = buildPlacementLayoutPlan(staticRoot, depth, ownership);
    const typeIdSet = new Set(allTypeIds);
    const typeInfo = collectTypeInfo(staticRoot);

    const state = new ViewState([staticRoot.id]);
    const selectedFields = new Set<string>();
    // Per-crate set of ghost ids whose violet re-export arrow the user
    // has opted to display. Default empty: arrows are off until the
    // user clicks the corresponding ghost row. Cleared by resetAll.
    const ghostArrowsShown = new Set<string>();

    let lastLayout: Layout | null = null;
    const draw = (): void => {
      // In focus mode, derive a render-time filter from the current selection.
      // ViewState is left alone — focus is purely a layout-input override.
      const focus = currentCtx?.focusMode ? computeFocus(currentCtx) : null;
      // Method arrows are opt-in. The set the layout consumes is
      // simply the method-kind subset of selectedFields, re-keyed as
      // `${typePath}\x1F${methodName}` (no kind segment, since the
      // layout already knows the target rows are methods). Field
      // entries are skipped — fields keep their always-on arrows.
      const methodArrowsShown = new Set<string>();
      for (const k of selectedFields) {
        const parsed = parseFieldKey(k);
        if (parsed.kind === 'method') {
          methodArrowsShown.add(`${parsed.typePath}\x1F${parsed.fieldName}`);
        }
      }
      const buildArgs = {
        staticRoot,
        ownership,
        depth,
        state,
        drift,
        measureText,
        placementPlan,
        ghostArrowsShown,
        methodArrowsShown,
        methodsHidden: currentCtx?.methodsHidden ?? false,
        ...(focus ? { focusModules: focus.modules } : {}),
      };
      lastLayout = buildLayout(buildArgs);
      if (currentCtx) currentCtx.lastLayout = lastLayout;
      applyFitScaleExtent(svg, layers, lastLayout);
      // Compute the union of arrow chains for every selected field. These are
      // drawn highlighted by default; hover unions a transient chain on top.
      const selectedFieldRefs = [...selectedFields].map((k) => parseFieldKey(k));
      const selectedArrows = chainArrowsFromMany(lastLayout, selectedFieldRefs);

      // Method-bucket expansion is stored in the same ViewState set as
      // module/type expansions; pull just those ids into a small
      // ReadonlySet so the renderer can flip chevrons without paying
      // the O(N) substring scan per row.
      const expandedBucketIds = new Set<string>();
      for (const id of state.expandedIds()) {
        if (id.includes('::__methods_')) expandedBucketIds.add(id);
      }

      renderTree(layers, lastLayout, {
        selectedFields,
        selectedArrows,
        expandedBucketIds,
        onToggle: (id) => {
          // Anchor the clicked item in both axes: expansion can change a
          // type's physical group, so preserving only y lets the target drift
          // sideways when its layout tier gets wider.
          const before = lookupPoint(lastLayout, id);
          const wasExpanded = state.isExpanded(id);
          state.toggle(id);
          if (!wasExpanded && typeIdSet.has(id)) {
            for (const moduleId of targetModulesFor(id, ownership, crateName)) {
              state.expand(moduleId);
            }
          }
          draw();
          const after = lookupPoint(lastLayout, id);
          const delta = anchorTranslation(before, after);
          if (delta !== null) {
            // Animated translate so the viewport tween runs in lockstep with
            // the renderer's transform tween, keeping the click target glued
            // under the cursor for the entire animation.
            layers.translateBy(delta.dx, delta.dy, true);
          }
        },
        onSelectField: (typePath, fieldName, kind) => {
          const key = fieldKey(typePath, fieldName, kind);
          if (selectedFields.has(key)) selectedFields.delete(key);
          else selectedFields.add(key);
          draw();
        },
        onShowOwners: (typePath, getDotScreenPos) => {
          const ownerIds = ownership.ownedBy.get(typePath);
          if (!ownerIds || ownerIds.length === 0) return;
          const owners = ownerIds
            .map((id) => {
              const info = typeInfo.get(id);
              if (!info) return null;
              return { typeId: id, typeLabel: info.label, modulePath: info.modulePath };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (owners.length === 0) return;
          const initiallyAllExpanded = ownerIds.every((id) => state.isExpanded(id));
          ownersOverlay.show({
            owners,
            getDotScreenPos,
            initiallyAllExpanded,
            onToggleExpandAll: () => toggleExpandAllOwnersOf(typePath),
          });
        },
        onHideOwners: () => ownersOverlay.hide(),
        onExpandAllOwners: (typePath) => {
          toggleExpandAllOwnersOf(typePath);
        },
        onFollowGhost: (ghostId, target) => {
          // Toggle whether this ghost's violet arrow is shown. Default
          // is hidden — arrows are opt-in to keep the canvas quiet across
          // a crate full of re-exports. Adding to the shown-set also
          // expands the target's ancestor modules so the arrow has a
          // visible endpoint to terminate at; we do NOT pan the viewport
          // (the user explicitly asked: toggle visibility, don't move
          // the canvas). Removing leaves all expansions untouched.
          if (ghostArrowsShown.has(ghostId)) {
            ghostArrowsShown.delete(ghostId);
          } else {
            ghostArrowsShown.add(ghostId);
            for (const m of ancestorModuleIds(target, crateName)) state.expand(m);
            state.expand(target);
            // Mirror onToggle's "auto-expand owned modules" step. When the
            // target type expands, its field arrows want to land on the
            // types it owns; without this, those modules stay collapsed
            // and the arrows can't be drawn until the user toggles the
            // type expansion themselves. (Reproducer: re-export `Instance`
            // — first follow shows Instance.fields but no arrow on
            // `store`; collapse-then-expand fills it in via onToggle.)
            if (typeIdSet.has(target)) {
              for (const moduleId of targetModulesFor(target, ownership, crateName)) {
                state.expand(moduleId);
              }
            }
          }
          draw();
        },
        onArrowNavigate: (hits, anchor) => {
          if (hits.length === 0) return;
          if (hits.length === 1) {
            const top = hits[0];
            if (top) navigateAlongArrow(top.arrow, top.zone, anchor);
            return;
          }
          // Multiple arrows under the click: ask the user which one
          // they meant. The popover handles dismissal; on pick it
          // routes back through navigateAlongArrow via currentCtx,
          // reusing the original click anchor so the chosen endpoint
          // still snaps under that spot.
          arrowDisambig.show({
            hits,
            anchorX: anchor.x,
            anchorY: anchor.y,
            typeLabel: (fullPath) => {
              // Prefer the layout's display label; fall back to the leaf
              // segment for synthesized ids (function-groups, ghosts) that
              // don't appear in typeInfo.
              const info = typeInfo.get(fullPath);
              if (info) return info.label;
              const seg = fullPath.split('::');
              return seg[seg.length - 1] ?? fullPath;
            },
          });
        },
      });
      minimap?.update(lastLayout);
    };

    const navigateToType = (typeId: string): void => {
      // Make the target visible: expand it (so its module is in focus
      // relevance and its row renders), expand its containing modules,
      // redraw, then center the viewport on its new y.
      for (const m of ancestorModuleIds(typeId, crateName)) state.expand(m);
      state.expand(typeId);
      draw();
      const y = lookupY(lastLayout, typeId);
      if (y !== null) layers.centerOnY(y, true);
    };

    // Pan so an arrow's chosen endpoint lands at the click anchor (NOT
    // the screen centre). For "body" clicks we navigate to the TARGET
    // (head waypoint); for "head" clicks we navigate to the SOURCE (tail
    // waypoint). Using the arrow's own waypoints means we don't need to
    // re-resolve the type box — those coords already match the rendered
    // geometry. Snapping under the cursor preserves the user's spatial
    // intuition: the spot they pointed at is where the endpoint shows up.
    const navigateAlongArrow = (
      arrow: Layout['arrows'][number],
      zone: 'body' | 'head',
      anchor: { x: number; y: number },
    ): void => {
      const w = arrow.waypoints;
      if (w.length < 2) return;
      const target = zone === 'head' ? w[0] : w[w.length - 1];
      if (!target) return;
      layers.panTo(target.x, target.y, anchor.x, anchor.y, true);
    };

    // Shared logic for the "owners" expand/fold toggle. Used by both the
    // dot click (onExpandAllOwners) and the popover's header button.
    //
    // If every owner type is already expanded, the action FOLDS them all
    // (collapses each owner type — leaves their ancestor modules as the
    // user left them, since those may have other content the user cares
    // about). Otherwise it EXPANDS all owners and their ancestors.
    //
    // Anchors the *hovered type itself* at its current screen position
    // through the layout transition (same trick as click-to-toggle), so
    // the dot — and any popover anchored to that dot — stays put while
    // surrounding content shifts. Returns true if owners are expanded
    // after the toggle, false if folded.
    const toggleExpandAllOwnersOf = (typePath: string): boolean => {
      const ownerIds = ownership.ownedBy.get(typePath);
      if (!ownerIds || ownerIds.length === 0) return false;
      const before = lookupPoint(lastLayout, typePath);
      const allExpanded = ownerIds.every((id) => state.isExpanded(id));
      if (allExpanded) {
        for (const ownerId of ownerIds) state.collapse(ownerId);
      } else {
        for (const ownerId of ownerIds) {
          for (const m of ancestorModuleIds(ownerId, crateName)) state.expand(m);
          state.expand(ownerId);
        }
      }
      draw();
      const after = lookupPoint(lastLayout, typePath);
      const delta = anchorTranslation(before, after);
      if (delta !== null) {
        layers.translateBy(delta.dx, delta.dy, true);
      }
      return !allExpanded;
    };

    const resetAll = (): void => {
      selectedFields.clear();
      state.clear();
      state.expand(staticRoot.id);
      ghostArrowsShown.clear();
      if (currentCtx) {
        currentCtx.focusMode = false;
        currentCtx.methodsHidden = false;
      }
      updateFocusModeIndicator(false);
      updateMethodsIndicator(false);
      arrowDisambig.hide();
      ownersOverlay.hideImmediately();
      draw();
      layers.resetTransform(true);
    };

    // Each crate gets a fresh ctx; switching crates resets focus mode and
    // its keybinding indicator so old per-crate state never leaks.
    currentCtx = {
      state,
      selectedFields,
      ownership,
      crateName,
      draw,
      typeIdSet,
      typeInfo,
      navigateToType,
      navigateAlongArrow,
      resetAll,
      focusMode: false,
      methodsHidden: false,
      lastLayout: null,
    };
    updateFocusModeIndicator(false);
    updateMethodsIndicator(false);
    draw();
  };

  renderFor(initial);
  select.addEventListener('change', () => renderFor(select.value));
}

async function tryLoadFacts(): Promise<Facts | null> {
  try {
    return await loadFacts(FACTS_URL);
  } catch (err) {
    if (err instanceof FactsLoadError) {
      showError(err.message);
    } else {
      showError(`unexpected error: ${String(err)}`);
    }
    return null;
  }
}

// Compute the fit-to-view minimum scale and apply it as the zoom's lower
// bound. Content fits at scale = min(viewportW / contentW, viewportH /
// contentH). FIT_PADDING leaves a small margin around the edges.
//
// The fit value is the *floor* of the allowed range — it stops the user
// from shrinking below "everything visible". When content is small enough
// to already fit at normal size (fit > 1), we cap the floor at 1.0 so we
// don't force-zoom IN; otherwise the empty default view ends up rendered
// at SCALE_MAX, which feels jarring. The ceiling is always SCALE_MAX.
function applyFitScaleExtent(
  svgEl: SVGSVGElement,
  layers: ReturnType<typeof attachZoom>,
  layout: Layout,
): void {
  const vw = svgEl.clientWidth;
  const vh = svgEl.clientHeight;
  if (vw <= 0 || vh <= 0 || layout.totalWidth <= 0 || layout.totalHeight <= 0) return;
  const fit = Math.min(vw / layout.totalWidth, vh / layout.totalHeight) * FIT_PADDING;
  layers.setScaleExtent(Math.min(fit, 1), SCALE_MAX);
}

// The most recently expanded type — `state` iterates in insertion order,
// so the last entry is the latest add. Modules are filtered out via
// `typeIdSet`. Returns null if nothing is expanded.
function mostRecentSelection(ctx: RenderCtx): string | null {
  let last: string | null = null;
  for (const id of ctx.state.expandedIds()) {
    if (ctx.typeIdSet.has(id)) last = id;
  }
  return last;
}

// Render-time focus filter, derived from ViewState's expanded set. Returns
// the set of module ids that should render in focus mode — closed under
// ancestors so the visible subtree stays connected. Anything not in this
// set is dropped entirely (no row, no name, no children).
//
// Members of the focus set:
//   - the crate root,
//   - the containing module (and ancestors) of every expanded type,
//   - the containing module (and ancestors) of every one-step arrow
//     target of an expanded type's fields, so direct outgoing chains
//     stay visible (their type box renders collapsed in those modules),
//   - the containing module (and ancestors) of every arrow target of a
//     selected field. (The owner is necessarily expanded, so it's
//     already covered by the first bullet.)
function computeFocus(ctx: RenderCtx): { modules: ReadonlySet<string> } {
  const { state, selectedFields, ownership, crateName, typeIdSet } = ctx;
  const modules = new Set<string>([crateName]);

  const addAncestors = (typeFullPath: string): void => {
    for (const m of ancestorModuleIds(typeFullPath, crateName)) modules.add(m);
  };

  for (const id of state.expandedIds()) {
    if (!typeIdSet.has(id)) continue;
    addAncestors(id);
    const fieldsMap = ownership.fieldTargets.get(id);
    if (fieldsMap) {
      for (const targets of fieldsMap.values()) {
        for (const t of targets) addAncestors(t);
      }
    }
  }

  for (const k of selectedFields) {
    const sep = k.lastIndexOf('::');
    const typePath = k.slice(0, sep);
    const fieldName = k.slice(sep + 2);
    addAncestors(typePath);
    const targets = ownership.fieldTargets.get(typePath)?.get(fieldName);
    if (targets) {
      for (const t of targets) addAncestors(t);
    }
  }

  return { modules };
}

// All module ids on the path to (and including) every field target's owning
// module — these need to be expanded for arrow targets to appear in the layout.
function targetModulesFor(typeId: string, ownership: OwnershipIndex, crateName: string): string[] {
  const out = new Set<string>();
  const fields = ownership.fieldTargets.get(typeId);
  if (!fields) return [];
  for (const targets of fields.values()) {
    for (const targetFullPath of targets) {
      for (const id of ancestorModuleIds(targetFullPath, crateName)) {
        out.add(id);
      }
    }
  }
  return [...out];
}

// `crate::a::b::Type` → [`crate`, `crate::a`, `crate::a::b`].
function ancestorModuleIds(typeFullPath: string, crateName: string): string[] {
  const segments = typeFullPath.split('::');
  if (segments[0] !== crateName || segments.length < 2) return [];
  const ids = [crateName];
  let path = '';
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i] ?? '';
    path = path === '' ? seg : `${path}::${seg}`;
    ids.push(`${crateName}::${path}`);
  }
  return ids;
}

function lookupY(layout: Layout | null, id: string): number | null {
  return lookupPoint(layout, id)?.y ?? null;
}

function lookupPoint(
  layout: Layout | null,
  id: string,
): { readonly x: number; readonly y: number } | null {
  if (!layout) return null;
  for (const t of layout.types) {
    if (t.id === id) return { x: t.x, y: t.y };
  }
  for (const m of layout.modules) {
    if (m.id === id) return { x: m.labelX, y: m.y };
  }
  return null;
}

function collectTypeIds(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.push(n.fullPath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function collectTypeModuleMap(root: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, n.modulePath);
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

// Lookup table for the owner popover: every type's display label and
// containing module path, keyed by its full path. Built once per crate.
function collectTypeInfo(root: TreeNode): Map<string, TypeInfo> {
  const out = new Map<string, TypeInfo>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, { label: n.label, modulePath: n.modulePath });
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function updateFocusModeIndicator(active: boolean): void {
  const el = document.querySelector<HTMLElement>('#hint-focus');
  if (!el) return;
  el.classList.toggle('active', active);
}

// Methods toggle indicator. The chip is labelled "methods", so the
// intuitive reading is "highlighted = methods are on." We light it up
// when methods are SHOWN (the default), and dim it when the user has
// toggled them off. Other "active" chips like focus light up to signal
// "this filter is engaged" — methods is the inverse: lit = nothing
// hiding the rows, dim = something is.
function updateMethodsIndicator(hidden: boolean): void {
  const el = document.querySelector<HTMLElement>('#hint-methods');
  if (!el) return;
  el.classList.toggle('active', !hidden);
}

function updateScaleIndicator(k: number): void {
  const el = document.querySelector<HTMLElement>('#scale-value');
  if (!el) return;
  el.textContent = `${Math.round(k * 100)}%`;
}

function installInputControls(
  svg: SVGSVGElement,
  layers: ReturnType<typeof attachZoom>,
): InputController {
  const POINTER_PAN_GAIN = 2.25;
  const WHEEL_PAN_GAIN = 1;
  const DRAG_START_PX = 3;
  const MAX_PAN_STEP_PX = 160;
  const defaultMode = detectDefaultInputMode();
  let mode = readStoredInputMode(defaultMode);
  let drag: {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null = null;
  let suppressNextClick = false;

  const applyMode = (): void => {
    layers.setWheelZoomFilter((event) => mode === 'mouse' || event.shiftKey || event.ctrlKey);
    svg.classList.toggle('trackpad-input', mode === 'trackpad');
    svg.classList.toggle('mouse-input', mode === 'mouse');
  };
  const panByViewportDelta = (dx: number, dy: number, gain: number): void => {
    layers.translateByScreen(
      -clampNumber(dx * gain, -MAX_PAN_STEP_PX, MAX_PAN_STEP_PX),
      -clampNumber(dy * gain, -MAX_PAN_STEP_PX, MAX_PAN_STEP_PX),
    );
  };

  const controller: InputController = {
    defaultMode,
    getMode: () => mode,
    setMode: (nextMode) => {
      mode = nextMode;
      localStorage.setItem(INPUT_MODE_KEY, mode);
      applyMode();
    },
  };

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('viewport-dragging');
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const totalDx = e.clientX - drag.startX;
    const totalDy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(totalDx, totalDy) < DRAG_START_PX) return;
    drag.moved = true;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    panByViewportDelta(dx, dy, POINTER_PAN_GAIN);
    e.preventDefault();
    e.stopPropagation();
  });
  const stopDrag = (e: PointerEvent): void => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    suppressNextClick = drag.moved;
    drag = null;
    svg.classList.remove('viewport-dragging');
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  };
  svg.addEventListener('pointerup', stopDrag);
  svg.addEventListener('pointercancel', stopDrag);
  svg.addEventListener(
    'click',
    (e) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  svg.addEventListener(
    'wheel',
    (e) => {
      if (mode !== 'trackpad' || e.shiftKey || e.ctrlKey) return;
      const delta = wheelDeltaPixels(e);
      panByViewportDelta(delta.x, delta.y, WHEEL_PAN_GAIN);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true, passive: false },
  );

  applyMode();
  return controller;
}

function setupInputSettings(controller: InputController): void {
  const toggle = document.querySelector<HTMLButtonElement>('.settings-toggle');
  const body = document.querySelector<HTMLElement>('#settings-body');
  const inputModeCheckbox = document.querySelector<HTMLInputElement>('#settings-trackpad-mode');
  const debugLayoutCheckbox = document.querySelector<HTMLInputElement>('#settings-debug-layout');
  const summary = document.querySelector<HTMLElement>('#settings-input-summary');
  const defaultBadge = document.querySelector<HTMLElement>('#settings-input-default');
  if (!toggle || !body || !inputModeCheckbox || !summary || !defaultBadge) return;

  let expanded = sessionStorage.getItem('mind-expander.settings.expanded') === '1';
  const applyExpanded = (): void => {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.hidden = !expanded;
    sessionStorage.setItem('mind-expander.settings.expanded', expanded ? '1' : '0');
  };
  const renderMode = (): void => {
    const mode = controller.getMode();
    inputModeCheckbox.checked = mode === 'trackpad';
    summary.textContent =
      mode === 'trackpad'
        ? 'Two-finger scroll pans. Shift + two-finger scroll zooms.'
        : 'Wheel zooms. Right-button drag pans.';
    defaultBadge.textContent = `default: ${controller.defaultMode}`;
  };
  const renderDebugLayout = (): void => {
    if (debugLayoutCheckbox) debugLayoutCheckbox.checked = layoutDebugEnabled();
  };

  applyExpanded();
  renderMode();
  renderDebugLayout();
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    applyExpanded();
  });
  inputModeCheckbox.addEventListener('change', () => {
    controller.setMode(inputModeCheckbox.checked ? 'trackpad' : 'mouse');
    renderMode();
  });
  debugLayoutCheckbox?.addEventListener('change', () => {
    localStorage.setItem(LAYOUT_DEBUG_STORAGE_KEY, debugLayoutCheckbox.checked ? '1' : '0');
    renderDebugLayout();
    currentCtx?.draw();
  });
}

function detectDefaultInputMode(): InputMode {
  return isMacOS() ? 'trackpad' : 'mouse';
}

function readStoredInputMode(defaultMode: InputMode): InputMode {
  const stored = localStorage.getItem(INPUT_MODE_KEY);
  return stored === 'mouse' || stored === 'trackpad' ? stored : defaultMode;
}

function isMacOS(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const uaPlatform = nav.userAgentData?.platform?.toLowerCase();
  return uaPlatform === 'macos' || navigator.platform.toLowerCase().includes('mac');
}

function wheelDeltaPixels(e: WheelEvent): { readonly x: number; readonly y: number } {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return { x: e.deltaX * 16, y: e.deltaY * 16 };
  }
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return { x: e.deltaX * window.innerWidth, y: e.deltaY * window.innerHeight };
  }
  return { x: e.deltaX, y: e.deltaY };
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function showError(message: string): void {
  const el = document.querySelector<HTMLElement>('#error');
  if (!el) {
    console.error(message);
    return;
  }
  el.textContent = message;
  el.hidden = false;
}
