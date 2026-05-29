//! Layout-placement E2E fixture — exercises the predecessor-relative
//! placement fix (src/layout/grid_placement.ts) end-to-end against the
//! real binary, plus dense non-overlap at scale.
//!
//! The crux of the predecessor fix: an owned target is floored only by
//! its OWN owner's right edge, so it packs in the column immediately
//! right of its owner. It must NOT be pushed right past UNRELATED types
//! that merely sit at the same depth (a "layer wall"). The bug this
//! guards is "owned target shoved past the unrelated same-depth block".
//!
//! Shape:
//!   * `Hub` (a root, depth 0) owns SIX children `C0..C5` (depth 1).
//!     The fix must place every `C*` in the column(s) immediately right
//!     of `Hub` — NEXT TO its owner.
//!   * `O0..O2` are OTHER roots (depth 0) that each own a child
//!     `OL0..OL2` (depth 1). These `OL*` are UNRELATED to Hub but live
//!     at the SAME depth as Hub's `C*` children. The fix must keep them
//!     to the RIGHT of Hub's children — Hub's children are never pushed
//!     past them.
//!   * `Pad00..Pad15` are unrelated root types with no children. They
//!     thicken the depth-0 band so the diagram is genuinely crowded
//!     (real-font, multi-sub-column) for the no-overlap-at-scale check —
//!     the density the tiny shared fixture cannot reproduce.
//!
//! Every struct field that names another struct emits an ownership edge
//! (owner -> owned), which the placement plan turns into a predecessor.

pub struct C0 {
    pub v: u32,
}
pub struct C1 {
    pub v: u32,
}
pub struct C2 {
    pub v: u32,
}
pub struct C3 {
    pub v: u32,
}
pub struct C4 {
    pub v: u32,
}
pub struct C5 {
    pub v: u32,
}

/// Single owner of all `C*` children — its children must render next to
/// it, not past the unrelated `OL*` block.
pub struct Hub {
    pub a: C0,
    pub b: C1,
    pub c: C2,
    pub d: C3,
    pub e: C4,
    pub f: C5,
}

pub struct OL0 {
    pub v: u32,
}
pub struct OL1 {
    pub v: u32,
}
pub struct OL2 {
    pub v: u32,
}

/// Unrelated roots, each owning one depth-1 child. The children
/// (`OL*`) share Hub's children's depth but belong to a different owner,
/// so they must stay to the right of Hub's children.
pub struct O0 {
    pub x: OL0,
}
pub struct O1 {
    pub x: OL1,
}
pub struct O2 {
    pub x: OL2,
}

pub struct Pad00 {
    pub v: u32,
}
pub struct Pad01 {
    pub v: u32,
}
pub struct Pad02 {
    pub v: u32,
}
pub struct Pad03 {
    pub v: u32,
}
pub struct Pad04 {
    pub v: u32,
}
pub struct Pad05 {
    pub v: u32,
}
pub struct Pad06 {
    pub v: u32,
}
pub struct Pad07 {
    pub v: u32,
}
pub struct Pad08 {
    pub v: u32,
}
pub struct Pad09 {
    pub v: u32,
}
pub struct Pad10 {
    pub v: u32,
}
pub struct Pad11 {
    pub v: u32,
}
pub struct Pad12 {
    pub v: u32,
}
pub struct Pad13 {
    pub v: u32,
}
pub struct Pad14 {
    pub v: u32,
}
pub struct Pad15 {
    pub v: u32,
}
