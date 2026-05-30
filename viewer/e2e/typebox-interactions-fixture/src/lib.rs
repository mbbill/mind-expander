//! Deterministic fixture for the GROUP K type-box HOVER / GLYPH / ANIMATION
//! E2E spec (`typebox-interactions.spec.ts`). It is shaped to surface every
//! hover-revealed affordance the spec drives with a real browser:
//!
//!   - `Engine` is a struct with a typed field (`power: u32`) so hovering a
//!     field row fades in the type-hint pill (`text.field-ty` / its bg).
//!   - `App.engine: Engine` makes `engine::Engine` OWNED by exactly one
//!     owner, so hovering Engine's kind-marker reveals an owner-count badge
//!     reading `(1)`.
//!   - Free functions with calls drive the call markers:
//!       * `dispatch()` calls `validate()` (same module) AND
//!         `helpers::log()` (other module) → 2 distinct outgoing callees, so
//!         its locality `→` glyph hover badge reads `(2)`.
//!       * `validate()` ALSO calls `helpers::log()`, so `helpers::log()` has
//!         TWO distinct incoming callers → its incoming `→` marker hover
//!         badge reads `(2)`.
//!
//! Free functions keep the call graph unambiguous (no receiver resolution),
//! mirroring the call-graph fixture's rationale.

pub mod helpers;

pub struct Engine {
    pub power: u32,
}

pub struct App {
    pub engine: Engine,
}

pub fn dispatch() {
    validate();
    helpers::log();
}

pub fn validate() {
    helpers::log();
}
