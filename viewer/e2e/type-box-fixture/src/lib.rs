//! Deterministic fixture for the type-box E2E spec.
//!
//! It exercises the visual + interactive surface of a single type box:
//!   - `engine::Engine` is a struct with TWO fields (so expanding reveals
//!     field rows) and TWO methods with arguments (so expanding reveals a
//!     method-bucket header and clicking a method name expands its
//!     signature into argument rows).
//!   - `Garage` re-exports `Engine` via `pub use` at the crate root, which
//!     the indexer surfaces as a GHOST type (rendered italic) distinct
//!     from the canonical `engine::Engine`.
pub mod engine;

// A `pub use` re-export. The indexer surfaces the re-exported name as a
// ghost type at the crate root, whose header label renders italic.
pub use engine::Engine as Garage;

pub struct App {
    pub engine: engine::Engine,
    pub name: String,
}
