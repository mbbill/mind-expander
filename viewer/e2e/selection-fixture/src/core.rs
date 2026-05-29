//! A type that owns a `Piston` (sub-owned type, so an ownership arrow
//! exists between two boxes) and carries BOTH a struct field and a method
//! — the field-vs-method-bucket selection distinction needs a type whose
//! members include a struct field plus at least one method bucket.

pub struct Engine {
    pub piston: Piston,
    pub power: u32,
}

impl Engine {
    /// A method, so `Engine`'s callable buckets are non-empty. Selecting
    /// the `power` FIELD must NOT auto-expand these buckets.
    pub fn start(&self) -> u32 {
        self.power
    }

    pub fn stop(&mut self) {
        self.power = 0;
    }
}

pub struct Piston {
    pub bore: u32,
}
