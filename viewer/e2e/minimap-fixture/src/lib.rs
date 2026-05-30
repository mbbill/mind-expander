//! Deterministic fixture for the minimap E2E. Intentionally TALL: many
//! modules, each with several pub/private structs (and fields), so that
//! when the crate is expanded the diagram's total content height exceeds
//! the 900px test viewport. A diagram taller than the viewport is what
//! makes minimap click/drag panning produce an OBSERVABLE vertical move
//! (with a short diagram the pan constraint keeps it centred and a click
//! is a no-op).

pub mod alpha;
pub mod beta;
pub mod gamma;
pub mod delta;
pub mod epsilon;
pub mod zeta;
pub mod eta;
pub mod theta;
