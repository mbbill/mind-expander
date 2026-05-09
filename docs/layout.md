# Layout Design Notes

This document records the intended direction for the graph layout. It is a
short architecture guide, not a complete implementation spec.

## Core Principle

Layout has two separate concerns:

- **Logical layout**: stable relationships between items, derived from facts.
- **Physical placement**: actual `x/y` coordinates, derived from measurement,
  visible expansion state, and collision avoidance.

Do not collapse these into formulas like `x = depth * fixedColumnWidth`.
Logical lanes are constraints, not pixels. Moving every item to the right must
not change any lane rule.

## Stable Logical Plan

The logical placement plan should be computed once from the static facts when
the graph is loaded. It is an ownership DAG plan:

- rank is derived from the structural ownership graph
- stable order inside one rank is facts-derived, currently name/module/path
- hard rightward constraints come from actual forward predecessors, not from
  every item in an earlier rank
- same-rank or backward/cyclic edges are diagnostic/routing facts, not hard
  placement frontiers

Rank is a logical relationship, not an x coordinate. A target with one owner
should sit to the right of that owner; it should not be pushed after unrelated
types that merely have smaller ranks.

Expansion state may change:

- item height
- visible row rectangles
- module band height
- arrow routes

Expansion state must not change:

- ownership rank
- stable order inside the same rank
- the set of forward predecessors

This avoids items jumping between columns or changing relative order when a
type, module, or function bucket is opened.

Physical positions are not persisted and previous positions are not used as
layout hints. Each render computes a fresh layout. Stability comes from the
deterministic algorithm and static ordering, not from remembering positions
from earlier user interactions.

## Same-Rank Spreading

There should not be a separate hard "sublane" relationship. Same-rank
spreading is a display optimization inside physical placement, not part of the
logical graph order.

The purpose of spreading is to avoid placing every item at one rank into one
tall column. The hard rule remains ownership predecessor order; same-rank
spreading chooses a stable physical assignment from the item count and stable
item order.

For now, use deterministic sort plus a band-level 16:9 target shape as a
physical placement heuristic based on rank, stable item order, and item count.
Do not use measured or expanded box size to compute order or group
assignment:

- sort same-rank items by stable facts-derived order
- choose a stable column/row assignment from the number of items and the
  band-level 16:9 target shape
- keep that assignment stable when boxes expand or shrink
- use measured rectangles only when finding the actual non-overlapping grid
  position for each assigned item

The 16:9 ratio is not a logical constraint and not a pixel coordinate system.
It only guides physical placement toward a normal widescreen shape.

Keep same-rank spreading behind a localized strategy function. The initial
strategy can be simple and count-based; future changes should replace that
strategy without rewriting measurement, placement, or routing.

## Band Shape Planner

The 16:9 target is planned for the whole module band, not independently for
one rank.

Different ranks create left-to-right planning groups, but only actual
predecessors create hard placement frontiers. If a band has many items at rank
1 and then one item each at ranks 2, 3, 4, 5, and 6, the later ranks already
consume horizontal shape. The rank-1 group should not choose its spread as if
it were the only content in the band.

Example input:

```text
rank 1: 10 items
rank 2: 1 item
rank 3: 1 item
rank 4: 1 item
rank 5: 1 item
rank 6: 1 item
```

The planner should choose same-rank spreading in the context of the full band.
Depending on the band shape, rank 1 may be better as:

```text
rank 1: 5 5
rank 2: 1
rank 3: 1
rank 4: 1
rank 5: 1
rank 6: 1
```

rather than:

```text
rank 1: 3 3 3 1
rank 2: 1
rank 3: 1
rank 4: 1
rank 5: 1
rank 6: 1
```

The shape planner's job is to choose how many same-rank display groups each
rank receives so the entire module band trends toward the 16:9 target.
Its inputs are rank, stable order, and counts. Measured box sizes are not
planner inputs; they belong to the later physical placement search.

Example for ten same-rank items:

```text
col 0: A B C
col 1: D E F
col 2: G H I
col 3: J
```

This relative assignment is fixed. If `A`, `B`, or `C` grow or shrink, `D`
still belongs to the next right-side group. Placement then searches the snap
grid for the first non-overlapping position for `D` near the top/right side.

"Right side" does not mean after the full bounding box of every item in the
previous group. If `A` is narrow and `B` is wide, `D` may sit to the right of
`A` while still not being to the right of `B`, as long as the snapped boxes do
not overlap. Avoid using whole-column bounding boxes as hard barriers, because
that creates large empty gaps.

## Ordered Items

Physical placement should consume ordered items, not fixed columns or logical
stacks.

The logical planner should produce a stable ordered sequence:

```text
non-rank/function groups
ownership rank 0 items in stable order
ownership rank 1 items in stable order
ownership rank 2 items in stable order
```

The physical placer should only need:

- item order
- rank boundaries
- forward predecessor ids
- measured rectangles

It may search the snap grid, slide items right, or otherwise compact the band
as long as forward predecessor constraints and same-rank stable assignment are
preserved.

The placement search strategy should also live behind a localized strategy
function. The initial strategy is top-to-bottom search. Future optimizations
can change the strategy without changing the logical plan or measurement
contracts.

## Physical Placement

Physical placement should solve from measured rectangles.

Every visible item should produce one or more layout rectangles before
placement decisions are finalized:

- normal type header/body
- expanded fields and method rows
- function-group pseudo types
- re-export/ghost rows
- long row protrusions, when they are treated separately

Most semantic objects should be measured as one layout box. A type whose
visible members are all normal length should place as one box containing its
header and visible rows.

Block width counts stable visible anchors:

- type header label at its rendered size
- type dots/kind markers and trailing expand chevrons
- field, function, method-bucket, and method names

Block width does not count hover/detail suffix text such as field `ty_text` or
method signatures. Those suffixes are visual annotations that may overflow the
normal member-name anchor. Counting them as block width makes one verbose Rust
type annotation force unrelated boxes far apart.

Exception: a super-long field, function, or method name may become its own
layout box for area computation and collision/routing. This prevents one
pathological member name from making the whole parent type box too wide.

This does not change visual readability or expansion behavior. The type still
renders normally as before. Splitting only changes the physical layout boxes:
one visual type may contribute several stacked boxes with different widths,
usually top-down.

Splitting a long member row is a physical layout detail only. It must not
create a new graph node or change:

- type identity
- ownership rank
- stable item order
- field/method ownership target
- click and expansion behavior

Spacing should come from rectangle bounds plus explicit gaps, not from global
worst-case reservations. Items may slide right if needed to avoid overlap, as
long as ownership predecessor constraints are preserved.

## Snap Grid

Physical placement should use a snap grid. Text and rows are measured in
normal pixel space first, then every layout box is rounded outward to grid
units:

```text
x = gridCol * cellWidth
y = gridRow * cellHeight
width = ceil(measuredWidth / cellWidth) * cellWidth
height = ceil(measuredHeight / cellHeight) * cellHeight
```

Never round inward. Snapped boxes must fully contain the measured content.

The grid is the source of truth for physical layout tokens. Header height,
field-row height, module indentation, box gaps, and minimum box widths should
be defined as grid-cell counts, not independent pixel constants. Text size and
text width are still measured in pixels, then snapped outward to cells.

The grid makes `x` and `y` follow the same placement model. Objects occupy
grid rectangles; free grid space becomes available routing space. This avoids
one-off pixel gaps and makes routing easier to reason about.

Module bands are y-axis ranges on the same grid. They split the global grid
vertically, but they should not impose a separate row system inside the band.
Items inside a module band may occupy as many grid rows as their snapped boxes
need, and the band height is derived from the occupied grid height.

Most placement and routing logic should use grid-cell indexes, not pixels:

```text
GridRect {
  col
  row
  cols
  rows
}
```

Pixels are still needed for text measurement and final rendering, but collision
checks, occupancy, and routing channels should primarily operate on grid
rectangles.

## Clearance

Each layout box has two grid rectangles:

```text
own       = snapped content rectangle
clearance = own expanded by the box's requested gap
```

Placement must respect both the existing boxes' clearance and the new box's
clearance:

```text
conflict(a, b) =
  overlaps(a.own, b.clearance) ||
  overlaps(a.clearance, b.own)
```

Both checks are required because clearance can be box-specific. A normal type
box may request more breathing room than a long member-row box. If only the new
box's own area is compared with existing clearance, placement becomes dependent
on insertion order and may violate the new box's requested gap.

Do not use clearance-vs-clearance as the default collision check. That
double-counts gap requests and creates too much empty space.

## LCA Layer Gap

Different LCA/rank layers need a minimum horizontal gap so arrows have room to
turn between layers. This gap is a layer-to-layer placement floor, not part of
any block's clearance rectangle.

Prelude/non-rank items are not LCA layers. They may reserve local module-band
space, but they must not become a global floor for the first real rank.

The LCA gap and block clearance are two minimums on the same physical
own-to-own distance. Do not add them together.

Example in grid cells:

```text
A own = 0..10
LCA layer gap = 3
block clearance requirement = 3
B min x = 10 + max(3, 3) = 13
```

If the block clearance requirement were 4:

```text
B min x = 10 + max(3, 4) = 14
```

So placement should compute the floor from the previous relevant layer's
own-right edge plus `max(lcaLayerGap, requiredBlockGap)`. If normal clearance
already satisfies the LCA gap, nothing extra happens. If it does not, increase
the spacing to satisfy the LCA gap.

## Unified Obstacles

The rectangle model used for placement, arrow routing, hit testing, and debug
overlay should be the same model.

Do not compute approximate debug rectangles separately from the layout data.
If the debug overlay shows a rectangle, that rectangle should be one the layout
or router actually reasons about.

The debug grid overlay must also come from the real placement grid metadata:
origin, cell size, and extent should be emitted by the layout pipeline. The
renderer may choose a lightweight visual representation, such as faint corner
dots, but it must not invent a different diagnostic grid. If the renderer
samples the grid for readability, the sample step must be fixed from the real
cell size, not from total layout extent; expanding a module can reveal more
dots, but it must not change the density of the already-visible area. The grid
overlay should avoid one DOM node per grid point; use a pattern/canvas-style
representation so diagnostics do not dominate paint cost.

## Arrow Routing

Routing runs after physical placement and does not feed back into placement:
layout owns block positions, routing owns the already-placed endpoints and the
per-arrow path around those blocks.

The current router has two routing-owned layers: `routing.ts` collects semantic
arrow endpoints and explicit source/target stubs, while `routing_field.ts`
builds the reusable clearance field and scores middle routes through it.

1. Field and method arrows start at the visible row arrow anchor.
2. Re-export arrows start at the ghost item's measured edge.
3. Source arrows may leave either side of the source block.
4. All arrows end at the target's left edge at `target.y`.
5. The final target stub is `1.5` grid cells: one grid cell for the arrow head
   and half a grid cell for the rounded corner.
6. Middle-route detours run on the boundaries of inflated clearance rectangles:
   `1.5` grid cells on each block's left side, `0.5` grid cells on the right,
   top, and bottom.
7. The initial source stub and final target stub are explicit exceptions that
   may cross their own block's clearance envelope; the middle route still
   avoids every inflated clearance rectangle.
8. The routing field chooses among checked paths by shortest length, then fewer
   turns, then a stable right-side tie-break.
9. Obstacles are the real placed fragments from layout, inflated only inside
   the routing pass.
10. A visible routed arrow must be one of those checked orthogonal paths. If
    the target entry or middle route cannot be cleared, the router emits a
    degenerate path instead of an unchecked diagonal.
11. Routing does not allocate lanes, avoid arrow overlap, or avoid crossings.
12. Debug routing still surfaces the real obstacle rectangles and placement
   grid for inspection.

## Non-Rank Items

Function groups and re-export/ghost rows do not participate in normal ownership
ranking, but they still need stable logical placement. Treat them as a prelude
group before normal rank groups: no one depends on them and they depend on
nothing for hard placement purposes.

Reserve space locally from the visible measured rectangles while preserving
the stable logical ordering.

## Required Invariants

Any significant layout change should add or update tests for these invariants:

- no visible item rectangles overlap inside a module band
- forward predecessor order is preserved after physical sliding
- expanding/collapsing an item does not change ownership rank, predecessor
  constraints, or stable item order
- expanding/collapsing an inspected item preserves its screen anchor in both
  axes when the item remains visible
- long field/method type annotations do not affect physical block width
- debug overlay rectangles cover the actual rendered stable affordances,
  including type expand chevrons
- debug overlay rectangles match the real placement obstacle model
- routing does not change physical block placement
- arrows land on the target left side with a left-to-right final stub
- routed arrows avoid non-source/non-target block fragments
- routing behavior changes are introduced through explicit contracts with
  focused invariant tests
