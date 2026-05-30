//! `Engine` owns a `parts::Piston` that lives one module DEEPER, so a
//! forward-routed expansion has a distinct module (`core::parts`) to open.

pub mod parts;

pub struct Engine {
    pub piston: parts::Piston,
    pub power: u32,
}

impl Engine {
    pub fn start(&self) -> u32 {
        self.power
    }
}
