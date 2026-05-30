//! Ghost / re-export Tier-3 fixture (GROUP J).
//!
//! Shape chosen so "follow a ghost forward-routes module expansion" is
//! OBSERVABLE across module boundaries:
//!
//!   crate root  : `pub use core::Engine;`  → ghost box `__re_Engine`
//!   core::Engine: owns `core::parts::Piston` (field `piston`)
//!   core::parts : the deeper module that holds the forward-owned Piston
//!   extra::Gadget: isolated, never relevant — a control that stays
//!                  collapsed when the ghost is followed.
//!
//! Following the ghost must (a) reveal the violet re-export arrow to the
//! canonical `core::Engine`, (b) expand `core` so Engine's box appears,
//! and (c) FORWARD-route into `core::parts` so `Piston` (a deeper
//! canonical-ownership target of Engine) becomes visible — without
//! touching the unrelated `extra` module.

pub mod core;
pub mod extra;

pub use core::Engine;

pub struct App {
    pub engine: core::Engine,
}
