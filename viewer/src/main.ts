import { zoomTransform } from 'd3';
import { type FunctionCallIndex, buildFunctionCallIndex } from './analysis/calls.ts';
import { computeDrift } from './analysis/drift.ts';
import {
  type Layout,
  callArrowKey,
  rowArrowKey,
  specificCallArrowKey,
} from './analysis/layout_model.ts';
import {
  type ModuleNode,
  type TreeNode,
  WORKSPACE_ROOT_ID,
  buildWorkspaceTree,
} from './analysis/module_tree.ts';
import {
  type OwnershipIndex,
  buildOwnershipIndex,
  computeOwnershipDepth,
} from './analysis/ownership.ts';
import { FactsLoadError, loadFacts } from './data/load.ts';
import type { Facts } from './data/schema.ts';
import { signatureExpansionId } from './layout/geometry.ts';
import { buildLayout } from './layout/pipeline.ts';
import { buildPlacementLayoutPlan } from './layout/placement_plan.ts';
import { ViewState } from './state/view_state.ts';
import { anchorTranslation } from './view/anchor.ts';
import { arrowDisambigViewportAction, createArrowDisambig } from './view/arrow_disambig.ts';
import { type CrateMenuItem, createCrateMenu } from './view/crate_menu.ts';
import { type EdgeEntry, createEdgePicker } from './view/edge_picker.ts';
import { cratePrefixOf, stripCratePrefix } from './view/display_path.ts';
import { type ArrowEndpoint, arrowEndpointLayoutPoint } from './view/arrow_navigation.ts';
import { lookupLayoutPoint, lookupMemberRowPoint } from './view/layout_lookup.ts';
import { createTextMeasurer } from './view/measure.ts';
import { type Minimap, createMinimap } from './view/minimap.ts';
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
  ownerFieldsPointingTo,
  sourceExpansionIdsForArrowSource,
  targetExpansionIdsForArrowTarget,
  targetExpansionIdsForMemberRow,
  targetModulesForMemberRow,
} from './view/type_expansion.ts';
import { attachZoom } from './view/zoom.ts';

const FACTS_URL = '/data/facts.json';
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
  /** Navigate to a module by id: expand the module and every ancestor
   *  module, redraw, then center the viewport on the module's row.
   *  Used by the cascading crate menu when the user picks a row. */
  readonly navigateToModule: (moduleId: string) => void;
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

  const svg = document.querySelector<SVGSVGElement>('#tree');
  const minimapRoot = document.querySelector<HTMLElement>('#minimap');
  if (!svg) {
    showError('missing required DOM element (#tree)');
    return;
  }
  // The crate dropdown is gone — multi-crate mode renders all workspace
  // crates stacked vertically. Hide the wrapper if it exists for
  // backwards compatibility with existing HTML.
  const crateSelectEl = document.querySelector<HTMLElement>('#crate');
  if (crateSelectEl) crateSelectEl.style.display = 'none';

  const crateNames = Object.keys(facts.crates).sort();
  if (crateNames.length === 0) {
    showError('facts.json contains no crates');
    return;
  }

  // Single canvas-backed measurer for the whole session — one canvas
  // element, one font binding, results memoized per string. Field names
  // recur across crates and re-renders so the cache pays back many times.
  const measureText = createTextMeasurer(`${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);
  // Companion bold measurer for module label chip widths — the crate-root
  // leaf renders bold, and bold text is wider than non-bold at the same size.
  const measureBoldText = createTextMeasurer(`bold ${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);

  let minimap: Minimap | null = null;
  let previousViewportTransform = { x: 0, y: 0, k: 1 };
  const stickyCrateEl = document.querySelector<HTMLElement>('#sticky-crate');
  // Cascading hover menu anchored to the sticky. Built once at session
  // startup; the host binds it to the current crate during
  // updateStickyCrate. Items are looked up from a per-crate cache
  // populated lazily by collectCrateMenuItems below.
  const crateMenuItemCache = new Map<string, readonly CrateMenuItem[]>();
  const collectCrateMenuItems = (
    crateName: string,
    root: ModuleNode | null,
  ): readonly CrateMenuItem[] => {
    if (root === null) return [];
    const cached = crateMenuItemCache.get(crateName);
    if (cached !== undefined) return cached;
    // Workspace root's direct children are crate ModuleNodes; find by id.
    const crateNode = (root.children as readonly TreeNode[]).find(
      (c): c is ModuleNode => c.kind === 'module' && c.id === crateName,
    );
    const items = crateNode === undefined ? [] : buildCrateMenuItems(crateNode);
    crateMenuItemCache.set(crateName, items);
    return items;
  };
  let lastStaticRoot: ModuleNode | null = null;
  const crateMenu = createCrateMenu({
    anchorEl: stickyCrateEl ?? document.createElement('div'),
    onPick: (moduleId) => {
      currentCtx?.navigateToModule(moduleId);
    },
  });
  let lastStickyCrate: string | null = null;
  // Sticky crate indicator: tells the user which crate they're inside
  // when the crate's own band has scrolled above the viewport top.
  // Recomputed on every pan/zoom (from the zoom callback) and after
  // every layout-changing draw (so expanding/collapsing rows doesn't
  // leave a stale label).
  const updateStickyCrate = (
    layout: Layout | null,
    t: { x: number; y: number; k: number },
  ): void => {
    if (!stickyCrateEl) return;
    if (layout === null) {
      stickyCrateEl.hidden = true;
      return;
    }
    // Data-space y of where the SVG canvas top edge currently sits.
    // The zoom transform applies as screen = k * data + ty, so
    // screen=0 maps to data = -ty / k.
    const dataYTop = -t.y / t.k;
    // The "current" crate is the crate-tier band (modDepth 0) with the
    // largest y still strictly above the viewport top. Strict less-than
    // means while the band itself is still visible we don't show the
    // sticky -- the band is doing the same job.
    let currentCrate: (typeof layout.modules)[number] | null = null;
    for (const m of layout.modules) {
      if (m.modDepth !== 0) continue;
      if (m.y < dataYTop) currentCrate = m;
      else break;
    }
    if (currentCrate === null) {
      stickyCrateEl.hidden = true;
      if (lastStickyCrate !== null) {
        lastStickyCrate = null;
        crateMenu.setItems(null, []);
      }
      return;
    }
    stickyCrateEl.textContent = currentCrate.label;
    stickyCrateEl.hidden = false;
    if (currentCrate.id !== lastStickyCrate) {
      lastStickyCrate = currentCrate.id;
      crateMenu.setItems(currentCrate.id, collectCrateMenuItems(currentCrate.id, lastStaticRoot));
    }
  };

  const layers = attachZoom(svg, (t) => {
    updateScaleIndicator(t.k);
    const arrowPopupAction = arrowDisambigViewportAction(previousViewportTransform, t);
    previousViewportTransform = t;
    if (arrowPopupAction.kind === 'move') {
      arrowDisambig.moveBy(arrowPopupAction.dx, arrowPopupAction.dy);
      // The call-target picker uses the same anchor-with-canvas
      // contract: pan moves it along with the underlying row; zoom
      // dismisses (the screen→data math doesn't survive a scale
      // change cleanly).
      edgePicker.moveBy(arrowPopupAction.dx, arrowPopupAction.dy);
    } else if (arrowPopupAction.kind === 'hide') {
      arrowDisambig.hide();
      edgePicker.hide();
    }
    minimap?.update(currentCtx?.lastLayout ?? null);
    updateStickyCrate(currentCtx?.lastLayout ?? null, t);
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

  // Per-edge call-arrow picker. Each row toggles ONE arrow's
  // visibility via specificCallArrowsShown — independent of the
  // row-level "show all" toggles. Shared across the setupWorkspace
  // lifetime since the picker has no per-instance state.
  const edgePicker = createEdgePicker();

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

  const setupWorkspace = (): void => {
    const staticRoot = buildWorkspaceTree(facts);
    lastStaticRoot = staticRoot;
    const ownership = buildOwnershipIndex(facts);
    const calls = buildFunctionCallIndex(facts, staticRoot);
    const allTypeIds = collectTypeIds(staticRoot);
    const typeModule = collectTypeModuleMap(staticRoot);
    const drift = computeDrift(ownership, typeModule);
    const depth = computeOwnershipDepth(ownership, allTypeIds, drift);
    const placementPlan = buildPlacementLayoutPlan(staticRoot, depth, ownership);
    const typeIdSet = new Set(allTypeIds);
    const typeInfo = collectTypeInfo(staticRoot);

    // Default expand: workspace root only — the user lands on a list of
    // collapsed crate bands and picks which one(s) to expand. The viewer
    // intentionally has no notion of a "primary" crate; this codebase is
    // a general-purpose multi-crate viewer, not a single-project frontend.
    const initialExpanded: string[] = [staticRoot.id];
    const state = new ViewState(initialExpanded);
    const selectedFields = new Set<string>();
    const incomingCallTargetsShown = new Set<string>();
    // Per-edge call arrow visibility. Each entry is a
    // specificCallArrowKey(callerFullPath, calleeFullPath); routing
    // composes this with the row-level show-all sets so picking one
    // callee from the picker reveals only that single edge.
    const specificCallArrowsShown = new Set<string>();
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
        specificCallArrowsShown,
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
        ownership,
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
              drift
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
          if (!wasExpanded) {
            // Chevron-open exposes the type's member rows. Method buckets
            // get expanded so function/method rows render by default —
            // they're useful as a structural overview.
            //
            // Field selections (the thing that materializes ownership
            // arrows) are deliberately NOT auto-set: the user opts in
            // per-row via name click, so opening a type doesn't flood
            // the canvas with arrows. The collapse path likewise leaves
            // selectedFields alone so a manual selection survives a
            // chevron-collapse → chevron-expand cycle.
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
              calls
            )) {
              state.expand(targetId);
            }
          }
          draw();
          const after = lookupMemberRowPoint(lastLayout, typePath, fieldName, kind);
          const delta = anchorTranslation(before, after);
          if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
        },
        onPickOutgoingCall: (callerFullPath, anchor) => {
          openCallEdgePicker('outgoing', callerFullPath, anchor);
        },
        onPickIncomingCaller: (calleeFullPath, anchor) => {
          openCallEdgePicker('incoming', calleeFullPath, anchor);
        },
        specificCallArrowsShown,
        onToggleSignature: (functionFullPath) => {
          // The (..) toggle is a render-time detail expansion. Use the
          // existing ViewState toggle keyed by `sig::<fullPath>` so it
          // shares the expand/collapse mechanics of every other toggle.
          state.toggle(signatureExpansionId(functionFullPath));
          draw();
        },
        onPickOwner: (typePath, anchor) => {
          openOwnerPicker(typePath, anchor);
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
            for (const m of ancestorModuleIds(target)) state.expand(m);
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
                drift
              )) {
                state.expand(moduleId);
              }
            }
          }
          draw();
        },
        onArrowNavigate: (hits, anchor) => {
          if (hits.length === 0) return;
          // Single arrow under the cursor → direct navigation, no popup.
          // The hit zone encodes WHICH half of the polyline the user
          // clicked: 'source' = first half ("I'm at the source, take me
          // to the target"), 'target' = second half ("I'm at the target,
          // take me back to the source"). There is no middle zone — a
          // disambig popup for a single arrow has nothing to pick from.
          if (hits.length === 1) {
            const top = hits[0];
            if (top) {
              const endpoint = top.zone === 'source' ? 'target' : 'source';
              navigateToArrowEndpoint(top.arrow, endpoint, anchor);
              return;
            }
          }
          // Multiple arrows under the cursor → popup. The popup captures
          // its own click anchor on pick, so the chosen endpoint pans to
          // where the user clicked inside the popup (not back to the
          // original arrow-click anchor, which is far from the cursor by
          // the time the user picks a row).
          arrowDisambig.show({
            hits,
            anchorX: anchor.x,
            anchorY: anchor.y,
            qualifiedTypePath: (fullPath) => qualifiedTypePath(fullPath, typeInfo),
          });
        },
      });
      minimap?.update(lastLayout);
      updateStickyCrate(lastLayout, previousViewportTransform);
    };

    // Opens the floating call-edge picker triggered from a callable
    // row's `→` glyph (outgoing) or its incoming marker (incoming).
    // Zero edges → no-op. One edge → toggle directly without showing
    // the picker. Two or more → show the picker so the user can pick
    // which arrow to reveal.
    const openCallEdgePicker = (
      direction: 'outgoing' | 'incoming',
      anchorFullPath: string,
      anchor: { readonly x: number; readonly y: number },
    ): void => {
      const edges = collectCallEdges(direction, anchorFullPath, calls);
      if (edges.length === 0) return;
      if (edges.length === 1 && edges[0] !== undefined) {
        toggleSpecificEdge(direction, anchorFullPath, edges[0].otherFullPath);
        return;
      }
      // Bold currently-active edges so the user can see state on open.
      const entries: EdgeEntry[] = edges.map((edge) => ({
        otherFullPath: edge.otherFullPath,
        label: edge.label,
        ...(edge.prefix !== undefined ? { prefix: edge.prefix } : {}),
        ...(edge.crateName !== undefined ? { crateName: edge.crateName } : {}),
        active: specificCallArrowsShown.has(
          direction === 'outgoing'
            ? specificCallArrowKey(anchorFullPath, edge.otherFullPath)
            : specificCallArrowKey(edge.otherFullPath, anchorFullPath),
        ),
      }));
      edgePicker.show({
        entries,
        anchorX: anchor.x,
        anchorY: anchor.y,
        direction,
        onPick: (entry) => {
          toggleSpecificEdge(direction, anchorFullPath, entry.otherFullPath);
        },
        // Bulk "show all": flip on every entry that isn't already
        // revealed. Uses revealSpecificEdge (the non-drawing variant)
        // so we redraw exactly ONCE at the end. withAnchorPin keeps
        // the callable row whose marker opened the picker fixed on
        // screen across the layout change.
        onShowAll: () => {
          withAnchorPin(anchorFullPath, () => {
            for (const edge of edges) {
              const key =
                direction === 'outgoing'
                  ? specificCallArrowKey(anchorFullPath, edge.otherFullPath)
                  : specificCallArrowKey(edge.otherFullPath, anchorFullPath);
              if (specificCallArrowsShown.has(key)) continue;
              revealSpecificEdge(direction, anchorFullPath, edge.otherFullPath);
            }
          });
        },
        // Bulk "hide all": clear this picker's edges from the
        // per-edge visibility set in one pass. Doesn't disturb edges
        // for other rows -- only the ones currently in the picker.
        // Anchor-pin so the row stays put when arrows disappear and
        // any auto-expanded modules collapse back (in a future
        // refinement; for now hide-all just clears keys, which still
        // changes target-side rendering enough to warrant the pin).
        onHideAll: () => {
          withAnchorPin(anchorFullPath, () => {
            for (const edge of edges) {
              const key =
                direction === 'outgoing'
                  ? specificCallArrowKey(anchorFullPath, edge.otherFullPath)
                  : specificCallArrowKey(edge.otherFullPath, anchorFullPath);
              if (!specificCallArrowsShown.has(key)) continue;
              specificCallArrowsShown.delete(key);
            }
          });
        },
      });
    };

    // Run `mutate`, redraw, and pan the viewport so the callable row
    // anchored by `anchorFullPath` stays at its pre-mutation screen
    // position. Same anchor-translation pattern onSelectField uses for
    // ownership arrows -- without it, expanding target modules to make
    // newly-revealed call arrows land can shove the canvas dozens of
    // rows and the user loses their place. Falls back to a plain draw
    // when the anchor row isn't in the call index (synthetic / not yet
    // registered).
    const withAnchorPin = (anchorFullPath: string, mutate: () => void): void => {
      const callerRow = calls.rowByFunction.get(anchorFullPath);
      if (callerRow === undefined) {
        mutate();
        draw();
        return;
      }
      const before = lookupMemberRowPoint(
        lastLayout,
        callerRow.typeId,
        callerRow.rowName,
        callerRow.rowKind,
      );
      mutate();
      draw();
      const after = lookupMemberRowPoint(
        lastLayout,
        callerRow.typeId,
        callerRow.rowName,
        callerRow.rowKind,
      );
      const delta = anchorTranslation(before, after);
      if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
    };

    // Type-row variant of withAnchorPin: pins the type whose dot opened
    // the owner picker. Mirrors the row-level pin but uses lookupPoint
    // (the type header position) since the user clicked the dot, not
    // a member row. Used by openOwnerPicker for single-owner toggle
    // and the show-all / hide-all bulk handlers below.
    const withTypePin = (typeId: string, mutate: () => void): void => {
      const before = lookupPoint(lastLayout, typeId);
      mutate();
      draw();
      const after = lookupPoint(lastLayout, typeId);
      const delta = anchorTranslation(before, after);
      if (delta !== null) layers.translateBy(delta.dx, delta.dy, true);
    };

    // Reveal every ownership-arrow from `ownerTypeId` to `ownedTypeId`.
    // Each field on the owner whose type resolves to the owned type
    // gets its (ownerType, fieldName, 'field') key added to
    // `selectedFields`, which is what the layout reads to allow a
    // drifted ownership arrow through the routing filter. The owner
    // type and its ancestor modules are expanded so the field row
    // actually renders. Same rule the old expand-all flow used; the
    // picker now owns it.
    const revealOwnerArrows = (ownerTypeId: string, ownedTypeId: string): void => {
      for (const fieldName of ownerFieldsPointingTo(ownership, ownerTypeId, ownedTypeId)) {
        selectedFields.add(fieldKey(ownerTypeId, fieldName, 'field'));
      }
      for (const m of ancestorModuleIds(ownerTypeId)) state.expand(m);
      state.expand(ownerTypeId);
    };

    // Hide every ownership-arrow from `ownerTypeId` to `ownedTypeId`.
    // Only clears the field keys; deliberately does NOT collapse the
    // owner type itself (the user may have it expanded for other
    // reasons), and doesn't touch keys for fields that don't point at
    // this target.
    const hideOwnerArrows = (ownerTypeId: string, ownedTypeId: string): void => {
      for (const fieldName of ownerFieldsPointingTo(ownership, ownerTypeId, ownedTypeId)) {
        selectedFields.delete(fieldKey(ownerTypeId, fieldName, 'field'));
      }
    };

    // True when every field on the owner that points at the target is
    // currently selected -- i.e., every potential arrow is visible.
    // Used to set `active` on the picker entry so the user sees current
    // state on open and to drive single-owner toggle.
    const ownerArrowsActive = (ownerTypeId: string, ownedTypeId: string): boolean => {
      const fields = ownerFieldsPointingTo(ownership, ownerTypeId, ownedTypeId);
      if (fields.length === 0) return false;
      return fields.every((fieldName) =>
        selectedFields.has(fieldKey(ownerTypeId, fieldName, 'field')),
      );
    };

    // Opens the owner picker for `typeId`. Mirrors the call-edge picker
    // contract: 0 owners no-op, 1 owner toggle directly, 2+ owners show
    // the floating picker so the user can pick which incoming owner's
    // arrows to reveal. The type's dot row is anchor-pinned through
    // the layout change so the click target stays put.
    const openOwnerPicker = (
      typeId: string,
      anchor: { readonly x: number; readonly y: number },
    ): void => {
      const ownerIds = ownership.ownedBy.get(typeId) ?? [];
      if (ownerIds.length === 0) return;
      if (ownerIds.length === 1 && ownerIds[0] !== undefined) {
        const onlyOwner = ownerIds[0];
        withTypePin(typeId, () => {
          if (ownerArrowsActive(onlyOwner, typeId)) {
            hideOwnerArrows(onlyOwner, typeId);
          } else {
            revealOwnerArrows(onlyOwner, typeId);
          }
        });
        return;
      }
      const anchorCrate = cratePrefixOf(typeId);
      const entries: EdgeEntry[] = ownerIds
        .map((ownerId): EdgeEntry | null => {
          const info = typeInfo.get(ownerId);
          if (info === undefined) return null;
          const ownerCrate = cratePrefixOf(ownerId);
          const isCrossCrate = ownerCrate !== '' && ownerCrate !== anchorCrate;
          const entry: EdgeEntry = {
            otherFullPath: ownerId,
            label: info.label,
            active: ownerArrowsActive(ownerId, typeId),
            ...(info.modulePath !== '' ? { prefix: `${info.modulePath}::` } : {}),
            ...(isCrossCrate ? { crateName: ownerCrate } : {}),
          };
          return entry;
        })
        .filter((entry): entry is EdgeEntry => entry !== null);
      if (entries.length === 0) return;
      edgePicker.show({
        entries,
        anchorX: anchor.x,
        anchorY: anchor.y,
        // Owners flow INTO the clicked type; fan the picker leftward so
        // it visually mirrors the incoming arrows.
        direction: 'incoming',
        onPick: (entry) => {
          withTypePin(typeId, () => {
            if (ownerArrowsActive(entry.otherFullPath, typeId)) {
              hideOwnerArrows(entry.otherFullPath, typeId);
            } else {
              revealOwnerArrows(entry.otherFullPath, typeId);
            }
          });
        },
        onShowAll: () => {
          withTypePin(typeId, () => {
            for (const ownerId of ownerIds) revealOwnerArrows(ownerId, typeId);
          });
        },
        onHideAll: () => {
          withTypePin(typeId, () => {
            for (const ownerId of ownerIds) hideOwnerArrows(ownerId, typeId);
          });
        },
      });
    };


    // Reveal an edge without redrawing. The bulk show-all path calls
    // this in a loop and redraws once at the end; single-click goes
    // through toggleSpecificEdge below which wraps reveal + draw.
    const revealSpecificEdge = (
      direction: 'outgoing' | 'incoming',
      anchorFullPath: string,
      otherFullPath: string,
    ): void => {
      const callerFullPath = direction === 'outgoing' ? anchorFullPath : otherFullPath;
      const calleeFullPath = direction === 'outgoing' ? otherFullPath : anchorFullPath;
      const key = specificCallArrowKey(callerFullPath, calleeFullPath);
      if (specificCallArrowsShown.has(key)) return;
      specificCallArrowsShown.add(key);
      // Expand the other endpoint's containing type/bucket/modules so
      // the arrow has somewhere to land. Mirrors what onSelectField
      // does for the row-level toggle.
      const targetCallableRow = calls.rowByFunction.get(otherFullPath);
      if (targetCallableRow !== undefined) {
        for (const m of ancestorModuleIds(targetCallableRow.typeId)) state.expand(m);
        state.expand(targetCallableRow.typeId);
        if (targetCallableRow.bucketId !== null) state.expand(targetCallableRow.bucketId);
      } else {
        // Unresolved or external callee: still try to expand ancestors
        // of the path so any matching type renders if it exists
        // somewhere in the workspace tree.
        for (const m of ancestorModuleIds(otherFullPath)) state.expand(m);
      }
    };

    const toggleSpecificEdge = (
      direction: 'outgoing' | 'incoming',
      anchorFullPath: string,
      otherFullPath: string,
    ): void => {
      const callerFullPath = direction === 'outgoing' ? anchorFullPath : otherFullPath;
      const calleeFullPath = direction === 'outgoing' ? otherFullPath : anchorFullPath;
      const key = specificCallArrowKey(callerFullPath, calleeFullPath);
      withAnchorPin(anchorFullPath, () => {
        if (specificCallArrowsShown.has(key)) {
          specificCallArrowsShown.delete(key);
        } else {
          revealSpecificEdge(direction, anchorFullPath, otherFullPath);
        }
      });
    };

    const navigateToType = (typeId: string): void => {
      // Make the target visible: expand it (so its module is in focus
      // relevance and its row renders), expand its containing modules,
      // redraw, then center the viewport on its new y.
      for (const m of ancestorModuleIds(typeId)) state.expand(m);
      state.expand(typeId);
      draw();
      const y = lookupY(lastLayout, typeId);
      if (y !== null) layers.centerOnY(y, true);
    };

    const navigateToModule = (moduleId: string): void => {
      // Expand every ancestor in the module chain (so the picked
      // module's row is reachable in the layout), then the module
      // itself (so its contents render), then center on its new y.
      for (const ancId of moduleAncestorIds(moduleId)) state.expand(ancId);
      state.expand(moduleId);
      draw();
      const point = lookupLayoutPoint(lastLayout, moduleId);
      if (point !== null) layers.centerOnY(point.y, true);
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
          ? targetExpansionIdsForArrowTarget(arrow, calls)
          : sourceExpansionIdsForArrowSource(arrow, calls);
      for (const id of ids) state.expand(id);
      draw();
      const point = arrowEndpointLayoutPoint(lastLayout, arrow, endpoint);
      if (!point) return;
      layers.panTo(point.x, point.y, anchor.x, anchor.y, true);
    };

    const resetAll = (): void => {
      selectedFields.clear();
      incomingCallTargetsShown.clear();
      specificCallArrowsShown.clear();
      state.clear();
      // Restore the initial expand set: workspace root only. Reset
      // mirrors the boot default — see the same comment at construction
      // time. No crate is treated as primary by this viewer.
      state.expand(staticRoot.id);
      ghostArrowsShown.clear();
      if (currentCtx) {
        currentCtx.focusMode = false;
        currentCtx.methodsHidden = false;
      }
      updateFocusModeIndicator(false);
      updateMethodsIndicator(false);
      arrowDisambig.hide();
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
      draw,
      typeIdSet,
      typeInfo,
      navigateToType,
      navigateToModule,
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

  setupWorkspace();
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
    typeIdSet,
  } = ctx;
  // Workspace root is always in focus so every crate-level label can
  // render. Per-type ancestors below add their own crate roots as needed.
  const modules = new Set<string>([WORKSPACE_ROOT_ID]);

  const addAncestors = (typeFullPath: string): void => {
    for (const m of ancestorModuleIds(typeFullPath)) modules.add(m);
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
        calls
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
interface CallEdgeRow {
  /** Full path of the OTHER endpoint of the edge (callee for outgoing,
   *  caller for incoming). */
  readonly otherFullPath: string;
  /** Display label of the other endpoint — usually
   *  `Type.method()` or `module::free_fn()`. */
  readonly label: string;
  /** Optional module-path prefix (e.g., `vm::store::`) — the path
   *  segments between the crate name and the function name, with the
   *  crate already removed. */
  readonly prefix?: string;
  /** Cross-crate accent: present only when the edge crosses a crate
   *  boundary from the anchor row. The picker renders it in purple so
   *  the boundary is visible at a glance. */
  readonly crateName?: string;
}

/** Build the list of edges to show in the picker. For 'outgoing':
 *  enumerate `callTargetsByFunction` resolved targets — those are the
 *  candidates the picker can toggle. For 'incoming': enumerate
 *  `incomingCallsByFunction` and dedupe by caller. Labels strip the
 *  anchor row's crate so same-crate callees read as `vm::store::put()`
 *  rather than `crate::vm::store::put()`; cross-crate entries keep
 *  their crate name so the boundary stays visible. */
function collectCallEdges(
  direction: 'outgoing' | 'incoming',
  anchorFullPath: string,
  calls: FunctionCallIndex,
): readonly CallEdgeRow[] {
  const anchorCrate = cratePrefixOf(anchorFullPath);
  if (direction === 'outgoing') {
    const targets = calls.callTargetsByFunction.get(anchorFullPath) ?? [];
    return targets.map((target) => callEdgeLabelParts(target.functionFullPath, anchorCrate));
  }
  const incoming = calls.incomingCallsByFunction.get(anchorFullPath) ?? [];
  const seen = new Set<string>();
  const out: CallEdgeRow[] = [];
  for (const ref of incoming) {
    if (seen.has(ref.caller)) continue;
    seen.add(ref.caller);
    out.push(callEdgeLabelParts(ref.caller, anchorCrate));
  }
  return out;
}

function callEdgeLabelParts(fullPath: string, anchorCrate: string): CallEdgeRow {
  // Split the path into three display segments:
  //   crateName  — the first `::` segment (only emitted when the edge
  //                crosses a crate boundary from the anchor row)
  //   prefix     — the module-path segments between crate and function
  //                name, joined with `::` and a trailing `::`
  //   label      — the function name with `()` appended
  // The picker renders each segment in its own span so the crate name
  // can be styled distinctly from the rest of the qualified path.
  const idx = fullPath.lastIndexOf('::');
  if (idx === -1) {
    return { otherFullPath: fullPath, label: `${fullPath}()` };
  }
  const beforeName = fullPath.slice(0, idx);
  const name = fullPath.slice(idx + 2);
  const ownCrate = cratePrefixOf(beforeName);
  // Module portion = everything between crate and function name. Empty
  // when the function lives directly inside the crate root.
  const moduleTail = stripCratePrefix(beforeName, ownCrate);
  const isCrossCrate = ownCrate !== '' && ownCrate !== anchorCrate;
  const out: CallEdgeRow = { otherFullPath: fullPath, label: `${name}()` };
  if (moduleTail !== '') return isCrossCrate
    ? { ...out, crateName: ownCrate, prefix: `${moduleTail}::` }
    : { ...out, prefix: `${moduleTail}::` };
  return isCrossCrate ? { ...out, crateName: ownCrate } : out;
}

function collectTypeInfo(root: TreeNode): Map<string, TypeInfo> {
  const out = new Map<string, TypeInfo>();
  const walk = (n: TreeNode): void => {
    if (n.kind === 'type') out.set(n.fullPath, { label: n.label, modulePath: n.modulePath });
    else for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function buildCrateMenuItems(node: ModuleNode): CrateMenuItem[] {
  // Walk a crate (or sub-module) ModuleNode and return its direct
  // submodule children as menu items, recursing for cascading levels.
  // Types are deliberately excluded -- the menu is purely a
  // navigation/expansion affordance for the module hierarchy.
  const out: CrateMenuItem[] = [];
  for (const child of node.children) {
    if (child.kind !== 'module') continue;
    out.push({
      id: child.id,
      label: child.label,
      children: buildCrateMenuItems(child),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function moduleAncestorIds(moduleId: string): string[] {
  // Return the chain of module ids leading down to `moduleId` (not
  // including it). For `c::a::b::c` returns [`c`, `c::a`, `c::a::b`].
  // Used by the crate menu's navigate flow to expand every ancestor
  // so the picked module's row actually renders.
  const parts = moduleId.split('::');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('::'));
  return out;
}

function qualifiedTypePath(
  fullPath: string,
  typeInfo: ReadonlyMap<string, TypeInfo>,
): string {
  const info = typeInfo.get(fullPath);
  const crateName = fullPath.split('::', 1)[0] ?? '';
  if (info !== undefined) {
    if (isFunctionGroupPath(fullPath)) {
      return info.modulePath === '' ? crateName : `${crateName}::${info.modulePath}`;
    }
    return info.modulePath === ''
      ? `${crateName}::${info.label}`
      : `${crateName}::${info.modulePath}::${info.label}`;
  }
  return stripFunctionGroupPath(fullPath);
}

function isFunctionGroupPath(fullPath: string): boolean {
  return fullPath.includes('::__fn_');
}

function stripFunctionGroupPath(fullPath: string): string {
  const markerIndex = fullPath.indexOf('::__fn_');
  return markerIndex === -1 ? fullPath : fullPath.slice(0, markerIndex);
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
