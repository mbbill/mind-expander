//! Dense deterministic fixture for the viewer arrow-routing E2E spec.
//!
//! `Hub` owns many `parts::*` structs. Expanding `Hub` emits one
//! ownership arrow per field, all fanning out from the same owner box —
//! so multiple arrow polylines share the owner's exit corridor and a
//! single click near it lands on 2+ arrows (the disambiguation case),
//! while the whole set exercises at-scale routing (many arrows attach
//! to their boxes without errors).
pub mod parts;

use parts::{
    Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet, Kilo, Lima,
};

pub struct Hub {
    pub alpha: Alpha,
    pub bravo: Bravo,
    pub charlie: Charlie,
    pub delta: Delta,
    pub echo: Echo,
    pub foxtrot: Foxtrot,
    pub golf: Golf,
    pub hotel: Hotel,
    pub india: India,
    pub juliet: Juliet,
    pub kilo: Kilo,
    pub lima: Lima,
}
