//! Focus-mode + resetAll Tier-3 fixture (GROUP G).
//!
//! A MULTI-LEVEL module tree so focus mode (a layout-input filter) has real
//! depth to keep and real off-path branches to drop, and so the focus
//! viewport-anchor tiers and resetAll have multiple expanded type boxes to
//! act on:
//!
//!   focus_fixture::App                    (root)  owns engine::core::Engine
//!   focus_fixture::engine::core::Engine           owns engine::core::Piston
//!   focus_fixture::engine::aux::Coolant   isolated sibling of engine::core
//!   focus_fixture::unrelated::widgets::Widget  isolated other top-level branch
//!
//! `App` selecting / expanding `Engine` makes the `engine::core` subtree
//! (and its ancestors) the focus-relevance set; `engine::aux` and the whole
//! `unrelated` branch are off-path, so their bands and type boxes drop out
//! of the layout entirely when focus engages — and return when it
//! disengages. resetAll then clears selection + expansion + focus + zoom.

pub mod engine {
    pub mod core {
        pub struct Engine {
            pub piston: Piston,
            pub power: u32,
        }

        impl Engine {
            pub fn start(&self) -> u32 {
                self.power
            }
        }

        pub struct Piston {
            pub bore: u32,
        }
    }

    pub mod aux {
        pub struct Coolant {
            pub temp_c: u32,
        }
    }
}

pub mod unrelated {
    pub mod widgets {
        pub struct Widget {
            pub id: u32,
        }
    }
}

pub struct App {
    pub engine: engine::core::Engine,
    pub name: String,
}
