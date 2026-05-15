import { type FunctionCallIndex, buildFunctionCallIndex } from './analysis/calls.ts';
import { computeDrift } from './analysis/drift.ts';
import {
  type Layout,
  callArrowKey,
  rowArrowKey,
  specificCallArrowKey,
} from './analysis/layout_model.ts';
import {
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
import {
  type ElementKind,
  buildSpanIndex,
  containingTypeBoxIdFor,
  findElementAtLine,
  lookupSpan,
} from './data/spans.ts';
import { buildFileTree } from './data/file_tree.ts';
import { createCodePanel } from './view/code_panel.ts';
import { signatureExpansionId } from './layout/geometry.ts';
import { buildLayout } from './layout/pipeline.ts';
import { buildPlacementLayoutPlan } from './layout/placement_plan.ts';
import { ViewState } from './state/view_state.ts';
import { anchorTranslation } from './view/anchor.ts';
import { arrowDisambigViewportAction, createArrowDisambig } from './view/arrow_disambig.ts';
import { type EdgeEntry, createEdgePicker } from './view/edge_picker.ts';
import { cratePrefixOf, stripCratePrefix } from './view/display_path.ts';
import { type ArrowEndpoint, arrowEndpointLayoutPoint } from './view/arrow_navigation.ts';
import {
  lookupElementPoint,
  lookupLayoutPoint,
  lookupMemberRowPoint,
} from './view/layout_lookup.ts';
import { createTextMeasurer } from './view/measure.ts';
import { type Minimap, createMinimap } from './view/minimap.ts';
import {
  FONT_FAMILY,
  FONT_SIZE_FIELD,
  LAYOUT_DEBUG_STORAGE_KEY,
  type FieldKeyKind,
  directArrowsFromMany,
  fieldKey,
  layoutDebugEnabled,
  parseFieldKey,
  type TreeRenderOptions,
  renderTree,
} from './view/tree.ts';
import { renderHtmlModuleTree } from './view/html_tree.ts';
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

// Single source of truth for facts: the Rust backend's `/api/facts`
// endpoint. In production, the same binary serves both this and the
// viewer bundle. In dev, the Vite config proxies this route to a
// locally-running `mind-expander view` process.
const FACTS_URL = '/api/facts';
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
  readonly navigateToType: (
    typeId: string,
    member?: { name: string; kind: FieldKeyKind },
  ) => void;
  /** Generic id-based navigation. Accepts a span-index element id
   *  (type / field / method / free function) and pans the diagram to
   *  whichever row matches in the current layout. Use this from the
   *  code panel — it doesn't need to know whether an id resolves to a
   *  type, a member, or a free function. */
  readonly navigateToElement: (elementId: string, kind: ElementKind) => void;
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
  const canvasScroll = document.querySelector<HTMLElement>('#canvas-scroll');
  const canvasContent = document.querySelector<HTMLElement>('#canvas-content');
  const htmlModules = document.querySelector<HTMLElement>('#html-modules');
  const minimapRoot = document.querySelector<HTMLElement>('#minimap');
  const recenterBtn = document.querySelector<HTMLButtonElement>('#recenter-btn');
  if (!svg || !canvasScroll || !canvasContent || !htmlModules) {
    showError('missing required DOM element (#tree / #canvas-scroll / #canvas-content / #html-modules)');
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

  // Source-span indexes for the code panel. The forward index maps an
  // element id (type fullPath, type::field, type::method, fn fullPath)
  // to its span; the byFile index supports reverse-navigation from a
  // clicked line back to the element it defines. When the extractor
  // doesn't emit per-item spans, the forward index falls back to the
  // module file (line 1) so Cmd+click still opens the right file.
  const spanIndex = buildSpanIndex(facts);
  // Directory tree built from every `mod.file` the extractor saw.
  // Powers the code panel's breadcrumb popup: clicking a path segment
  // lists the folders/files known at that depth without us needing a
  // backend filesystem-browse endpoint.
  const fileTree = buildFileTree(Array.from(spanIndex.moduleByFile.keys()));
  // Diagram-side mirror of the code panel's selection. We keep only
  // the original element id — the renderer derives the type-box and
  // row matches from it (see `rowMatchesSelection` /
  // `typeMatchesSelection` in tree.ts). Keyed by `(id, kind)` so a
  // struct field and a like-named method don't collide.
  let selectedElementId: string | null = null;
  let selectedElementKind: ElementKind | null = null;
  const setDiagramSelection = (
    elementId: string | null,
    kind: ElementKind | null,
  ): void => {
    selectedElementId = elementId;
    selectedElementKind = kind;
    if (elementId !== null && kind !== null && currentCtx !== null) {
      // Expand whichever type-box visibly contains this element so
      // its row will render. The index handles all cases uniformly:
      //   • type T              → containerId = T
      //   • field/method T::x   → containerId = T
      //   • free function       → containerId = the function_group
      //                           pseudo-type holding it
      // For methods the container is a real type whose method
      // buckets are also collapsed by default — expand those too so
      // the method row appears alongside the type's fields.
      const containerId = containingTypeBoxIdFor(spanIndex, elementId, kind);
      if (containerId !== null) {
        currentCtx.state.expand(containerId);
        if (kind === 'method' && spanIndex.types.has(containerId)) {
          for (const bucketId of callableBucketIdsForType(containerId, currentCtx.calls)) {
            currentCtx.state.expand(bucketId);
          }
        }
      }
    }
    currentCtx?.draw();
  };
  const codePanel = createCodePanel({
    onLineNavigate: (file, line) => {
      const hit = findElementAtLine(spanIndex, file, line);
      if (hit === null) return;
      const { elementId, kind } = hit;
      // Repaint the panel's highlight to the clicked element's full
      // span so the user sees what got selected by clicking on code.
      const span = lookupSpan(spanIndex, elementId, kind);
      if (span !== null) {
        codePanel.setHighlight(span.start_line, span.end_line);
      }
      setDiagramSelection(elementId, kind);
      // navigateToElement handles types, methods/fields, AND free
      // functions in one path — it finds whichever row matches in
      // the current layout. Disambiguates field vs method via kind.
      currentCtx?.navigateToElement(elementId, kind);
    },
    onClose: () => setDiagramSelection(null, null),
    fileTree,
    // Breadcrumb popup → user picked a file. Route through openCodeFor
    // with kind='module' when we know the module so the diagram side
    // also updates; otherwise just show the file.
    onShowFile: (absolutePath) => {
      const moduleId = spanIndex.moduleByFile.get(absolutePath);
      if (moduleId !== undefined) {
        openCodeFor(moduleId, 'module');
      } else {
        codePanel.show({ file: absolutePath, startLine: 1, endLine: 1 });
      }
    },
  });
  const openCodeFor = (id: string, kind: ElementKind): void => {
    const span = lookupSpan(spanIndex, id, kind);
    if (span === null) return;
    setDiagramSelection(id, kind);
    codePanel.show({ file: span.file, startLine: span.start_line, endLine: span.end_line });
  };

  // Single canvas-backed measurer for the whole session — one canvas
  // element, one font binding, results memoized per string. Field names
  // recur across crates and re-renders so the cache pays back many times.
  const measureText = createTextMeasurer(`${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);
  // Companion bold measurer for module label chip widths — the crate-root
  // leaf renders bold, and bold text is wider than non-bold at the same size.
  const measureBoldText = createTextMeasurer(`bold ${FONT_SIZE_FIELD}px ${FONT_FAMILY}`);

  let minimap: Minimap | null = null;
  let previousViewportTransform = { x: 0, y: 0, k: 1 };
  let lastDrawnK = 1;
  // First-draw flag: on the very first draw we anchor scrollTop to
  // TOP_PADDING so the user lands with the content at the viewport
  // top rather than at the empty padding above it.
  let firstDraw = true;
  // "Back to content" indicator visibility check. Returns true when at
  // least one pixel of the diagram is inside the viewport. The button
  // is hidden when visible, shown when the user has scrolled / panned
  // so far that none of the content is on screen — a one-click recovery
  // without forcing the user to hunt via the minimap.
  const isContentVisible = (): boolean => {
    const layout = currentCtx?.lastLayout;
    if (!layout || layout.totalWidth <= 0 || layout.totalHeight <= 0) return true;
    const t = layers.getTransform();
    const w = canvasScroll.clientWidth;
    const h = canvasScroll.clientHeight;
    const TOP = h; // matches the TOP_PADDING used in canvas-content sizing
    // Vertical: content occupies viewport y in [TOP - scrollTop,
    // TOP - scrollTop + totalHeight*k]. Visible iff that intersects [0, h].
    const cTop = TOP - canvasScroll.scrollTop;
    const cBot = cTop + layout.totalHeight * t.k;
    const vVisible = cTop < h && cBot > 0;
    // Horizontal: content occupies viewport x in [t.x, t.x + totalWidth*k].
    const cLeft = t.x;
    const cRight = t.x + layout.totalWidth * t.k;
    const hVisible = cLeft < w && cRight > 0;
    return vVisible && hVisible;
  };
  const updateRecenterVisibility = (): void => {
    if (!recenterBtn) return;
    const shouldHide = isContentVisible();
    if (recenterBtn.hidden !== shouldHide) recenterBtn.hidden = shouldHide;
  };
  // Latest HTML-tree options, updated on every draw. The zoom callback
  // reads these to refresh the HTML overlay when k changes without
  // having to plumb the closure-captured opts into a separate channel.
  let htmlTreeOpts: {
    onToggle: (id: string) => void;
    onScrollToModule: (id: string) => void;
    onShowCode: (id: string) => void;
  } | null = null;
  const layers = attachZoom(svg, canvasScroll, (t) => {
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
    updateRecenterVisibility();
    // When zoom changes, the canvas-content dimensions and the HTML
    // module tree's per-row heights/positions need to rescale. Pan-only
    // events leave them untouched — native scrolling handles the visual
    // update without rebuilding the DOM.
    if (t.k !== lastDrawnK) {
      lastDrawnK = t.k;
      const layout = currentCtx?.lastLayout;
      if (layout) {
        // canvas-content has clientHeight of padding above AND below
        // the actual diagram (totalHeight*k), so the user can over-
        // scroll past either edge by a viewport-height's worth of
        // empty space. SVG + html-modules sit at top:TOP_PADDING so
        // their data y=0 aligns with the start of the content area.
        const TOP = canvasScroll.clientHeight;
        canvasContent.style.height = `${TOP + layout.totalHeight * t.k + TOP}px`;
        svg.style.top = `${TOP}px`;
        svg.style.height = `${layout.totalHeight * t.k}px`;
        htmlModules.style.top = `${TOP}px`;
        if (htmlTreeOpts) renderHtmlModuleTree(htmlModules, layout, t.k, canvasScroll, htmlTreeOpts);
      }
    }
  });
  if (recenterBtn) {
    // Reset translations to default; preserve the user's zoom level k.
    // The zoom-event mirror in zoom.ts puts scrollTop back to TOP_PADDING
    // automatically when ty = 0.
    recenterBtn.addEventListener('click', () => {
      const t = layers.getTransform();
      layers.setTransform(t.k, 0, 0, true);
    });
  }
  const inputController = installInputControls(svg, canvasScroll, layers);
  if (minimapRoot) minimap = createMinimap(minimapRoot, canvasScroll, layers);
  updateScaleIndicator(1);

  // Cursor tracking + overview-toggle state. Space presses cycle between
  // the user's current view and a fit-all overview; the second press snaps
  // to k=1 with the data point under the cursor as the anchor. Any user
  // pan/zoom gesture in between resets the toggle so the next space press
  // re-enters overview rather than acting on stale state.
  const cursor = { x: 0, y: 0, inside: false };
  let overviewActive = false;
  canvasScroll.addEventListener('pointermove', (e) => {
    const rect = canvasScroll.getBoundingClientRect();
    cursor.x = e.clientX - rect.left;
    cursor.y = e.clientY - rect.top;
    cursor.inside = true;
  });
  canvasScroll.addEventListener('pointerleave', () => {
    cursor.inside = false;
  });
  const resetOverview = (): void => {
    overviewActive = false;
  };
  canvasScroll.addEventListener('pointerdown', resetOverview);
  canvasScroll.addEventListener('wheel', resetOverview, { passive: true });

  const handleSpace = (): void => {
    const layout = currentCtx?.lastLayout;
    if (!layout) return;
    // The SVG is now sized to the full content extent (totalHeight*k),
    // so its clientHeight is no longer the visible viewport height.
    // Use the scroll container — its dimensions ARE the viewport.
    const w = canvasScroll.clientWidth;
    const h = canvasScroll.clientHeight;
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
      const t = layers.getTransform();
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
      updateRecenterVisibility();
      const layout = currentCtx?.lastLayout;
      if (layout) {
        applyFitScaleExtent(svg, layers, layout);
        minimap?.update(layout);
      }
    }, 100);
  });

  const setupWorkspace = (): void => {
    const staticRoot = buildWorkspaceTree(facts);
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

      const treeOpts: TreeRenderOptions = {
        selectedFields,
        incomingCallTargetsShown,
        selectedArrows,
        expandedBucketIds,
        ownership,
        selectedElementId,
        selectedElementKind,
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
        onScrollToModule: (moduleId: string) => {
          const m = lastLayout?.modules.find((x) => x.id === moduleId);
          if (!m || !lastLayout) return;
          // Place the clicked module's row at the top of the viewport,
          // just below whatever sticky rows still apply above it. Animated
          // so the user sees the canvas scrolling back rather than
          // teleporting.
          layers.panYToTop(m.y, 0, true);
        },
        onShowCode: (id, kind) => openCodeFor(id, kind),
      };
      renderTree(layers, lastLayout, treeOpts);
      // Size the scrollable canvas-content area to match the diagram's
      // data extent at the current zoom. Without this the scroll
      // container has nothing to scroll past and `position: sticky` on
      // the HTML headers never engages.
      const k = previousViewportTransform.k;
      lastDrawnK = k;
      // canvas-content padded by clientHeight above + below the content
      // so scroll covers both over-scroll regions symmetrically; the
      // SVG and html-modules sit inside that pad zone at top:TOP.
      const TOP = canvasScroll.clientHeight;
      canvasContent.style.height = `${TOP + lastLayout.totalHeight * k + TOP}px`;
      svg.style.top = `${TOP}px`;
      svg.style.height = `${lastLayout.totalHeight * k}px`;
      htmlModules.style.top = `${TOP}px`;
      // First-time layout has scrollTop = 0 (browser default). Re-anchor
      // to the natural-default position (TOP) so the user sees the
      // content at the viewport top, not the empty padding above it.
      // Subsequent draws preserve the user's scroll position.
      if (firstDraw) {
        firstDraw = false;
        canvasScroll.scrollTop = TOP;
      }
      htmlTreeOpts = {
        onToggle: treeOpts.onToggle,
        onScrollToModule: treeOpts.onScrollToModule,
        // Cmd+click on a module label in the left tree → open the
        // module's source file via the span index's `'module'` kind.
        onShowCode: (id) => openCodeFor(id, 'module'),
      };
      renderHtmlModuleTree(htmlModules, lastLayout, k, canvasScroll, htmlTreeOpts);
      minimap?.update(lastLayout);
      updateRecenterVisibility();
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

    const navigateToType = (
      typeId: string,
      member?: { name: string; kind: FieldKeyKind },
    ): void => {
      // Make the target visible: expand its module ancestors and the
      // type itself, redraw, then pan so the focus point lands in the
      // uncovered part of the viewport. The code panel reports its
      // own screen rect; we avoid landing the focus point under it.
      // Member rows take priority over the type header when named.
      for (const m of ancestorModuleIds(typeId)) state.expand(m);
      state.expand(typeId);
      draw();
      let point: { readonly x: number; readonly y: number } | null = null;
      if (member !== undefined) {
        point = lookupMemberRowPoint(lastLayout, typeId, member.name, member.kind);
      }
      if (point === null) point = lookupLayoutPoint(lastLayout, typeId);
      if (point === null) return;
      const target = pickFocusScreenPoint(canvasScroll, codePanel.getScreenRect());
      layers.panTo(point.x, point.y, target.x, target.y, true);
    };

    // Element-id navigation: works for types, members, AND free
    // functions. The latter live in a `function_group` pseudo-type
    // that the host can't address by id, so we resolve the row from
    // the layout after a redraw (`lookupElementPoint` uses the same
    // matcher as the renderer's selection). `kind` disambiguates
    // field-vs-method when the two share an id.
    const navigateToElement = (elementId: string, kind: ElementKind): void => {
      for (const m of ancestorModuleIds(elementId)) state.expand(m);
      if (kind === 'type' && typeIdSet.has(elementId)) state.expand(elementId);
      draw();
      const point = lookupElementPoint(lastLayout, elementId, kind);
      if (point === null) return;
      const target = pickFocusScreenPoint(canvasScroll, codePanel.getScreenRect());
      layers.panTo(point.x, point.y, target.x, target.y, true);
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
      navigateToElement,
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

/** Member ids are `<typeFullPath>::<memberName>`. Trim the trailing
 *  segment if the forward index has an entry for it (i.e. the prefix
 *  IS a type). Otherwise return the id unchanged — it's likely already
 *  a type or a free function. */
// Where on screen we'd like a "focused" data-space point to land,
// given the diagram viewport and an optional rect (e.g. the code
// panel) we want to keep clear. Returns a point in window coords —
// `layers.panTo` takes the same coord space.
//
// Default is the viewport centre. When `avoid` covers the centre on
// one side, we shift to the centre of the uncovered side along that
// axis. If `avoid` straddles the centre on an axis (e.g. a full-width
// overlay), we fall back to the viewport mid-point for that axis —
// nothing better to do without shrinking the diagram itself.
function pickFocusScreenPoint(
  viewportEl: HTMLElement,
  avoid: DOMRect | null,
): { x: number; y: number } {
  const vp = viewportEl.getBoundingClientRect();
  const midX = vp.left + vp.width / 2;
  const midY = vp.top + vp.height / 2;
  if (avoid === null) return { x: midX, y: midY };

  let x = midX;
  if (avoid.left >= midX && avoid.left > vp.left) {
    // Panel on the right of centre → focus in the left half.
    x = (vp.left + Math.min(avoid.left, vp.right)) / 2;
  } else if (avoid.right <= midX && avoid.right < vp.right) {
    // Panel on the left of centre → focus in the right half.
    x = (Math.max(avoid.right, vp.left) + vp.right) / 2;
  }

  let y = midY;
  if (avoid.top >= midY && avoid.top > vp.top) {
    y = (vp.top + Math.min(avoid.top, vp.bottom)) / 2;
  } else if (avoid.bottom <= midY && avoid.bottom < vp.bottom) {
    y = (Math.max(avoid.bottom, vp.top) + vp.bottom) / 2;
  }

  return { x, y };
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
  scrollEl: HTMLElement,
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

  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    scrollEl.setPointerCapture(e.pointerId);
    svg.classList.add('viewport-dragging');
    e.preventDefault();
  });
  scrollEl.addEventListener('pointermove', (e) => {
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
    if (scrollEl.hasPointerCapture(e.pointerId)) scrollEl.releasePointerCapture(e.pointerId);
  };
  scrollEl.addEventListener('pointerup', stopDrag);
  scrollEl.addEventListener('pointercancel', stopDrag);
  scrollEl.addEventListener(
    'click',
    (e) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
  scrollEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  scrollEl.addEventListener(
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
