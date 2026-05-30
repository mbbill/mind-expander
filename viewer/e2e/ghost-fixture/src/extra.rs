//! Isolated module: `Gadget` is owned by nothing and owns nothing. It is
//! the control for "following a ghost does NOT expand unrelated modules".

pub struct Gadget {
    pub id: u32,
}
