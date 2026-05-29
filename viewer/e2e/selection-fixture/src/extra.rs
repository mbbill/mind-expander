//! An isolated module: `Gadget` is owned by nothing and owns nothing in
//! the rest of the crate. When focus mode is engaged around a selection
//! in `core`, this module is NOT in the relevance set, so its band — and
//! the `Gadget` box — drop out of the layout entirely. That removal is
//! the observable focus-mode oracle (focus is a layout-input filter, not
//! an opacity dim — see analysis/visibility + layout/geometry).

pub struct Gadget {
    pub id: u32,
}
