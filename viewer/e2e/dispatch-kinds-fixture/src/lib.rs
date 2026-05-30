//! Dispatch-kinds E2E fixture for GROUP M. One small crate that exposes
//! every diagram row kind the Cmd/Ctrl+click dispatch must route:
//!   • a type box (`App`, `Gauge`),
//!   • a struct field row (`App::gauge`, `Gauge::reading`),
//!   • a method row + its method bucket (`Gauge::read`),
//!   • a free-function row (`boot`),
//!   • a ghost / re-export row (`pub use ... as Gauge` at the crate root).
//! Line numbers below are load-bearing — the spec asserts the code panel
//! scrolls to these exact spans, so keep this file shape stable.
pub mod widgets;

// Re-export of the nested `Gauge` type → the viewer synthesises a GHOST
// type box (`dk_fixture::__re_Dial`) in the crate-root module. Cmd+click
// on that ghost row is the kind under test for the re-export case.
pub use widgets::gauge::Gauge as Dial;

pub struct App {
    pub gauge: Gauge,
    pub name: String,
}

/// A free function defined at the crate root. Cmd/Ctrl+click on its
/// diagram row opens the code panel scrolled to these lines.
pub fn boot() -> u32 {
    42
}
