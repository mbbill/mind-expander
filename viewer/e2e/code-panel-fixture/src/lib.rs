//! Code-panel E2E fixture. Has a nested module directory
//! (`widgets/gauge.rs`) so the code panel's breadcrumb renders a
//! clickable FOLDER segment (`widgets ›`) in addition to the file
//! segment — the default geometry fixture is flat (`src/*.rs`) and
//! collapses to a file-only crumb, so it can't exercise the popup.
pub mod widgets;

use widgets::gauge::Gauge;

pub struct App {
    pub gauge: Gauge,
    pub name: String,
}

/// A free function defined at the crate root. Cmd/Ctrl+click on its
/// diagram row must open the code panel scrolled to these lines.
pub fn boot() -> u32 {
    42
}
