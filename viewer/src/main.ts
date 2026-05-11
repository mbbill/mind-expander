import { zoomTransform } from 'd3';
import { type FunctionCallIndex, buildFunctionCallIndex } from './analysis/calls.ts';
import { computeDrift } from './analysis/drift.ts';
import { type Layout, callArrowKey, rowArrowKey } from './analysis/layout_model.ts';
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
import { arrowDisambigViewportAction, createArrowDisambig } from './view/arrow_disambig.ts';
import { type ArrowEndpoint, arrowEndpointLayoutPoint } from './view/arrow_navigation.ts';
import { lookupLayoutPoint, lookupMemberRowPoint } from './view/layout_lookup.ts';
import { createTextMeasurer } from './view/measure.ts';
import { type Minimap, createMinimap } from './view/minimap.ts';
import { createOwnersOverlay } from './view/owners_overlay.ts';
import {
  FONT_FAMILY,
  FONT_SIZE_FIELD,
  LAYOUT_DEBUG_STORAGE_KEY,
  directArrowsFromMany,
  fieldKey,
  layoutDebugEnabled,
  parseFieldKey,
  renderTree,
} from './view/tree.ts';
import {
  ancestorModuleIds,
  callableBucketIdsForType,
  callerExpansionIdsForFunction,
  forwardRoutedTargetModulesFor,
  memberArrowRowsForType,
  sourceExpansionIdsForArrowSource,
  targetExpansionIdsForArrowTarget,
  targetExpansionIdsForMemberRow,
  targetModulesForMemberRow,
} from './view/type_expansion.ts';
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
  readonly incomingCallTargetsShown: ReadonlySet<string>;
  readonly ownership: OwnershipIndex;
  readonly calls: FunctionCallIndex;
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
  /** Navigate to one endpoint of `arrow`. `endpoint === 'source'` lands at
   *  the caller; `endpoint === 'target'` lands at the callee. Direct canvas
   *  clicks (and disambig picks) pass an anchor so the chosen endpoint pans
   *  to that screen point instead of jumping to centre. The endpoint row
   *  is expanded into view before the pan, so the data-space point is read
   *  from the freshly built layout rather than the arrow's stale waypoints. */
  readonly navigateToArrowEndpoint: (
    arrow: Layout['arrows'][number],
    endpoint: ArrowEndpoint,
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
  // Companion bold measurer for module label chip widths — the crate-root
  // leaf renders bold, and bold text is wider than non-bold at the same size.
  const measureBoldText = createTextMeasurer(`bold ${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);

  let minimap: Minimap | null = null;
  let previousViewportTransform = { x: 0, y: 0, k: 1 };
  const layers = attachZoom(svg, (t) => {
    updateScaleIndicator(t.k);
    // The owner popover is anchored in screen space to the dot's current
    // position. Notify it on every pan/zoom so it can either dismiss
    // (default) or, when pinned, follow the dot to its new spot.
    ownersOverlay.onCanvasMoved();
    const arrowPopupAction = arrowDisambigViewportAction(previousViewportTransform, t);
    previousViewportTransform = t;
    if (arrowPopupAction.kind === 'move') {
      arrowDisambig.moveBy(arrowPopupAction.dx, arrowPopupAction.dy);
    } else if (arrowPopupAction.kind === 'hide') {
      arrowDisambig.hide();
    }
    minimap?.update(currentCtx?.lastLayout ?? null);
  });
  const inputController = installInputControls(svg, layers);
  if (minimapRoot) minimap = createMinimap(minimapRoot, svg, layers);
  updateScaleIndicator(1);

  // Cursor tracking + overview-toggle state. Space presses cycle between
  // the user's current view and a fit-all overview; the second press snaps
  // to k=1 with the data point under the cursor as the anchor. Any user
  // pan/zoom gesture in between resets the toggle so the next space press
  // re-enters overview rather than acting on stale state.
  const cursor = { x: 0, y: 0, inside: false };
  let overviewActive = false;
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    cursor.x = e.clientX - rect.left;
    cursor.y = e.clientY - rect.top;
    cursor.inside = true;
  });
  svg.addEventListener('pointerleave', () => {
    cursor.inside = false;
  });
  const resetOverview = (): void => {
    overviewActive = false;
  };
  svg.addEventListener('pointerdown', resetOverview);
  svg.addEventListener('wheel', resetOverview, { passive: true });

  const handleSpace = (): void => {
    const layout = currentCtx?.lastLayout;
    if (!layout) return;
    const w = svg.clientWidth;
    const h = svg.clientHeight;
    if (w <= 0 || h <= 0 || layout.totalWidth <= 0 || layout.totalHeight <= 0) return;
    if (!overviewActive) {
      // Enter overview: scale-to-fit centred on the content.
      const fit = Math.min(w / layout.totalWidth, h / layout.totalHeight) * FIT_PADDING;
      const tx = w / 2 - (layout.totalWidth / 2) * fit;
      const ty = h / 2 - (layout.totalHeight / 2) * fit;
      layers.setTransform(fit, tx, ty, true);
      overviewActive = true;
    } else {
      // Exit overview: k=1, with the data point currently under the cursor
      // staying under the cursor (or the screen centre if the cursor is
      // outside the SVG).
      const sx = cursor.inside ? cursor.x : w / 2;
      const sy = cursor.inside ? cursor.y : h / 2;
      const t = zoomTransform(svg);
      const dataX = (sx - t.x) / t.k;
      const dataY = (sy - t.y) / t.k;
      layers.setTransform(1, sx - dataX, sy - dataY, true);
      overviewActive = false;
    }
  };

  // The owner popover is a single global instance reused across crates.
  // Click-to-navigate routes through currentCtx so it picks up the right
  // per-crate state.
  const ownersOverlay = createOwnersOverlay({
    onNavigate: (typeId) => currentCtx?.navigateToType(typeId),
  });

  // Disambiguation popover. Both endpoints in each row are independently
  // clickable: source label navigates to the caller, target label navigates
  // to the callee. The popup itself supplies the click/keyboard anchor for
  // each pick — that's where the cursor (or focus) is at activation time,
  // which is the screen position the chosen endpoint pans to. Using the
  // original arrow-click anchor would jump the target far from where the
  // user is now looking inside the popup.
  const arrowDisambig = createArrowDisambig({
    onPick: (hit, endpoint, anchor) => {
      currentCtx?.navigateToArrowEndpoint(hit.arrow, endpoint, anchor);
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
    if (e.code === 'Space') {
      // Don't fire on auto-repeat — the toggle should require deliberate
      // taps. Prevent default so the page doesn't scroll on focus elsewhere.
      if (e.repeat) return;
      e.preventDefault();
      handleSpace();
      return;
    }
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
  const overviewHint = document.querySelector<HTMLElement>('#hint-overview');
  if (overviewHint) overviewHint.addEventListener('click', () => handleSpace());

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
    const calls = buildFunctionCallIndex(facts, crateName, staticRoot);
    const allTypeIds = collectTypeIds(staticRoot);
    const typeModule = collectTypeModuleMap(staticRoot);
    const drift = computeDrift(ownership, typeModule);
    const depth = computeOwnershipDepth(ownership, allTypeIds, drift);
    const placementPlan = buildPlacementLayoutPlan(staticRoot, depth, ownership);
    const typeIdSet = new Set(allTypeIds);
    const typeInfo = collectTypeInfo(staticRoot);

    const state = new ViewState([staticRoot.id]);
    const selectedFields = new Set<string>();
    const incomingCallTargetsShown = new Set<string>();
    let previewCallArrowKey: string | null = null;
    // Per-crate set of ghost ids whose violet re-export arrow the user
    // has opted to display. Default empty: arrows are off until the
    // user clicks the corresponding ghost row. Cleared by resetAll.
    const ghostArrowsShown = new Set<string>();

    let lastLayout: Layout | null = null;
    const draw = (): void => {
      // In focus mode, derive a render-time filter from the current selection.
      // ViewState is left alone — focus is purely a layout-input override.
      const focus = currentCtx?.focusMode ? computeFocus(currentCtx) : null;
      // Member arrows are opt-in: selecting a row asks layout to emit that
      // row's arrow, selecting it again removes the key so redraw hides it.
      const fieldArrowsShown = new Set<string>();
      const callArrowsShown = new Set<string>();
      for (const k of selectedFields) {
        const parsed = parseFieldKey(k);
        if (parsed.kind === 'field') {
          fieldArrowsShown.add(rowArrowKey(parsed.typePath, parsed.fieldName));
        } else {
          callArrowsShown.add(callArrowKey(parsed.typePath, parsed.fieldName, parsed.kind));
        }
      }
      if (previewCallArrowKey !== null) callArrowsShown.add(previewCallArrowKey);
      const buildArgs = {
        staticRoot,
        ownership,
        calls,
        depth,
        state,
        drift,
        measureText,
        measureBoldText,
        placementPlan,
        ghostArrowsShown,
        fieldArrowsShown,
        callArrowsShown,
        incomingCallTargetsShown,
        methodsHidden: currentCtx?.methodsHidden ?? false,
        ...(focus ? { focusModules: focus.modules } : {}),
      };
      lastLayout = buildLayout(buildArgs);
      if (currentCtx) currentCtx.lastLayout = lastLayout;
      applyFitScaleExtent(svg, layers, lastLayout);
      // Pan-constraint bounds: cover the whole content rect so the screen
      // centre is always over something. Origin is (0,0); the diagram is
      // laid out in the positive quadrant from there.
      layers.setContentBounds({
        x0: 0,
        y0: 0,
        x1: lastLayout.totalWidth,
        y1: lastLayout.totalHeight,
      });
      // Compute the union of direct outgoing arrows for every selected row.
      // Selection is local to the selected object; downstream rows do not
      // become highlighted just because their owner type is expanded.
      const selectedFieldRefs = [...selectedFields].map((k) => parseFieldKey(k));
      const selectedArrows = directArrowsFromMany(lastLayout, selectedFieldRefs);

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
        incomingCallTargetsShown,
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
            for (const moduleId of forwardRoutedTargetModulesFor(
              id,
              ownership,
              depth,
              drift,
              crateName,
            )) {
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
        onToggleTypeMembers: (typePath) => {
          const before = lookupPoint(lastLayout, typePath);
          const wasExpanded = state.isExpanded(typePath);
          state.toggle(typePath);
          const rows = memberArrowRowsForType(typePath, ownership, calls);
          if (wasExpanded) {
            for (const row of rows)
              selectedFields.delete(fieldKey(typePath, row.rowName, row.rowKind));
          } else {
            // Chevron-open means "open this type for inspection": expose
            // function rows, but only field rows become selected by default.
            for (const row of rows) {
              if (row.rowKind !== 'field') continue;
              selectedFields.add(fieldKey(typePath, row.rowName, row.rowKind));
              for (const targetId of targetExpansionIdsForMemberRow(
                typePath,
                row.rowName,
                row.rowKind,
                ownership,
                calls,
                crateName,
              )) {
                state.expand(targetId);
              }
            }
            for (const bucketId of callableBucketIdsForType(typePath, calls)) {
              state.expand(bucketId);
            }
          }
          draw();
          const after = lookupPoint(lastLayout, typePath);
          const delta = anchorTranslation(before, after);
          if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
        },
        onSelectField: (typePath, fieldName, kind) => {
          const before = lookupMemberRowPoint(lastLayout, typePath, fieldName, kind);
          const key = fieldKey(typePath, fieldName, kind);
          if (selectedFields.has(key)) {
            selectedFields.delete(key);
          } else {
            selectedFields.add(key);
            for (const targetId of targetExpansionIdsForMemberRow(
              typePath,
              fieldName,
              kind,
              ownership,
              calls,
              crateName,
            )) {
              state.expand(targetId);
            }
          }
          draw();
          const after = lookupMemberRowPoint(lastLayout, typePath, fieldName, kind);
          const delta = anchorTranslation(before, after);
          if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
        },
        onToggleIncomingCalls: (typePath, fieldName, kind, functionFullPath) => {
          const before = lookupMemberRowPoint(lastLayout, typePath, fieldName, kind);
          if (incomingCallTargetsShown.has(functionFullPath)) {
            incomingCallTargetsShown.delete(functionFullPath);
          } else {
            incomingCallTargetsShown.add(functionFullPath);
            for (const targetId of callerExpansionIdsForFunction(
              functionFullPath,
              calls,
              crateName,
            )) {
              state.expand(targetId);
            }
          }
          draw();
          const after = lookupMemberRowPoint(lastLayout, typePath, fieldName, kind);
          const delta = anchorTranslation(before, after);
          if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
        },
        onPreviewCallArrows: (typePath, fieldName, kind) => {
          const next = callArrowKey(typePath, fieldName, kind);
          if (previewCallArrowKey === next) return lastLayout;
          previewCallArrowKey = next;
          draw();
          return lastLayout;
        },
        onClearCallArrowPreview: (typePath, fieldName, kind) => {
          const current = callArrowKey(typePath, fieldName, kind);
          if (previewCallArrowKey !== current) return;
          previewCallArrowKey = null;
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
            // Mirror type-toggle's forward-LCA target expansion so a followed
            // ghost exposes the same routeable forward ownership arrows as a
            // direct click on the canonical type, without opening backward or
            // drift target modules.
            if (typeIdSet.has(target)) {
              for (const moduleId of forwardRoutedTargetModulesFor(
                target,
                ownership,
                depth,
                drift,
                crateName,
              )) {
                state.expand(moduleId);
              }
            }
          }
          draw();
        },
        onArrowNavigate: (hits, anchor) => {
          if (hits.length === 0) return;
          // Single unambiguous direct-nav zones bypass the popup. The
          // 'source' zone (first 50px) means "I'm at source, take me to
          // target"; the 'target' zone (last 50px) means "I'm at target,
          // take me back to source". Middle-of-single-arrow clicks fall
          // through to the popup so the user picks a direction explicitly.
          if (hits.length === 1) {
            const top = hits[0];
            if (top && top.zone === 'source') {
              navigateToArrowEndpoint(top.arrow, 'target', anchor);
              return;
            }
            if (top && top.zone === 'target') {
              navigateToArrowEndpoint(top.arrow, 'source', anchor);
              return;
            }
          }
          // Multi-arrow OR single-arrow-middle: open the popup. The popup
          // captures its own click anchor on pick, so the chosen endpoint
          // pans to where the user clicked inside the popup (not back to
          // the original arrow-click anchor, which is far from the cursor
          // by the time the user picks a row).
          arrowDisambig.show({
            hits,
            anchorX: anchor.x,
            anchorY: anchor.y,
            qualifiedTypePath: (fullPath) => qualifiedTypePath(fullPath, typeInfo, crateName),
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

    // Single navigation path for both direct-click and popup-pick. The
    // chosen endpoint's row is first expanded into view (otherwise the
    // freshly built layout still hides it), then we look up its data-space
    // point in the post-redraw layout and pan that point to the user's
    // click anchor. Looking up the point in the new layout — not from the
    // arrow's stale waypoints — is what makes the chosen endpoint actually
    // land where the user clicked.
    const navigateToArrowEndpoint = (
      arrow: Layout['arrows'][number],
      endpoint: ArrowEndpoint,
      anchor: { x: number; y: number },
    ): void => {
      const ids =
        endpoint === 'target'
          ? targetExpansionIdsForArrowTarget(arrow, calls, crateName)
          : sourceExpansionIdsForArrowSource(arrow, calls, crateName);
      for (const id of ids) state.expand(id);
      draw();
      const point = arrowEndpointLayoutPoint(lastLayout, arrow, endpoint);
      if (!point) return;
      layers.panTo(point.x, point.y, anchor.x, anchor.y, true);
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
      incomingCallTargetsShown.clear();
      previewCallArrowKey = null;
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
      incomingCallTargetsShown,
      ownership,
      calls,
      crateName,
      draw,
      typeIdSet,
      typeInfo,
      navigateToType,
      navigateToArrowEndpoint,
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
//     target of an expanded type's fields, so direct outgoing context
//     stays visible (their type box renders collapsed in those modules),
//   - the containing module (and ancestors) of every arrow target of a
//     selected field. (The owner is necessarily expanded, so it's
//     already covered by the first bullet.)
function computeFocus(ctx: RenderCtx): { modules: ReadonlySet<string> } {
  const {
    state,
    selectedFields,
    incomingCallTargetsShown,
    ownership,
    calls,
    crateName,
    typeIdSet,
  } = ctx;
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
    const parsed = parseFieldKey(k);
    addAncestors(parsed.typePath);
    if (parsed.kind === 'field') {
      const targets = ownership.fieldTargets.get(parsed.typePath)?.get(parsed.fieldName);
      if (targets) {
        for (const t of targets) addAncestors(t);
      }
    } else {
      for (const moduleId of targetModulesForMemberRow(
        parsed.typePath,
        parsed.fieldName,
        parsed.kind,
        ownership,
        calls,
        crateName,
      )) {
        modules.add(moduleId);
      }
    }
  }

  for (const functionFullPath of incomingCallTargetsShown) {
    const targetRow = calls.rowByFunction.get(functionFullPath);
    if (targetRow !== undefined) addAncestors(targetRow.typeId);
    for (const call of calls.incomingCallsByFunction.get(functionFullPath) ?? []) {
      addAncestors(call.callerRow.typeId);
    }
  }

  return { modules };
}

function lookupY(layout: Layout | null, id: string): number | null {
  return lookupPoint(layout, id)?.y ?? null;
}

function lookupPoint(
  layout: Layout | null,
  id: string,
): { readonly x: number; readonly y: number } | null {
  return lookupLayoutPoint(layout, id);
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

function qualifiedTypePath(
  fullPath: string,
  typeInfo: ReadonlyMap<string, TypeInfo>,
  crateName: string,
): string {
  const info = typeInfo.get(fullPath);
  if (info !== undefined) {
    if (isFunctionGroupPath(fullPath)) return info.modulePath;
    return info.modulePath === '' ? info.label : `${info.modulePath}::${info.label}`;
  }

  return stripCratePrefix(stripFunctionGroupPath(fullPath), crateName);
}

function isFunctionGroupPath(fullPath: string): boolean {
  return fullPath.includes('::__fn_');
}

function stripFunctionGroupPath(fullPath: string): string {
  const markerIndex = fullPath.indexOf('::__fn_');
  return markerIndex === -1 ? fullPath : fullPath.slice(0, markerIndex);
}

function stripCratePrefix(fullPath: string, crateName: string): string {
  const prefix = `${crateName}::`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
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
  if (!toggle || !body || !inputModeCheckbox || !summary || !defaultBadge) {
    return;
  }

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
