//! Selection / focus Tier-3 fixture.
//!
//! `App` (root module) owns an `Engine` (in `core`), which owns a
//! `Piston`. The root ALSO `pub use`s `core::Engine`, producing a
//! re-export — the viewer renders that as a ghost type box at the root
//! (italic marker + label) whose violet re-export arrow points at the
//! canonical `core::Engine`, and is revealed by clicking the ghost.
pub mod core;
pub mod extra;

pub use core::Engine;

pub struct App {
    pub engine: core::Engine,
    pub name: String,
}
