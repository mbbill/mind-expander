//! Tiny deterministic fixture for the viewer E2E geometry test.
//! `App` owns an `Engine` (in `core`), which owns a `Cylinder`.
pub mod core;

use core::Engine;

pub struct App {
    pub engine: Engine,
    pub name: String,
}
