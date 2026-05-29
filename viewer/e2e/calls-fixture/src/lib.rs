//! Deterministic fixture for the call-graph-arrows E2E spec.
//!
//! Shape (free functions only, so the call graph is unambiguous):
//!   crate root `lib.rs`:
//!     dispatch()  -> calls validate() (same module, local)
//!                 -> calls helpers::format() (other module, external)
//!                 -> calls helpers::log() (other module, external)
//!     validate()  -> calls helpers::log()  (so log() has 2 distinct callers)
//!   module `helpers`:
//!     format()    leaf
//!     log()       called by dispatch() AND validate() (incoming fan = 2)
//!
//! This gives:
//!   - dispatch(): 3 distinct outgoing callees (picker opens; >1).
//!   - dispatch() -> validate(): same-module (local / grey) call arrow.
//!   - dispatch() -> helpers::format(): other-module (external / blue) arrow.
//!   - helpers::log(): 2 distinct incoming callers (incoming picker opens).

pub mod helpers;

pub fn dispatch() {
    validate();
    helpers::format();
    helpers::log();
}

pub fn validate() {
    helpers::log();
}
