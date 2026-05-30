//! Owned leaf type. `Vault::boxed` owns this, so an ownership arrow runs
//! from the `boxed` field row to this box.

pub struct Box_ {
    pub size: u32,
}
