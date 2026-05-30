//! Selection / member-interactions Tier-3 fixture.
//!
//! The shape this fixture exists to provide — and that no other e2e
//! fixture has — is a single type that carries a struct field AND an
//! inherent method SHARING A NAME (`store`). Both members resolve to the
//! same canonical id `Vault::store`; only the `(id, kind)` pair tells them
//! apart. Selecting one must light exactly its own row, never its
//! same-name twin. That is the recurring selection bug GROUP F guards.
//!
//! `Vault` also owns a `Box_` (in `core`) via its `boxed` field, so
//! selecting a member produces a real ownership arrow to highlight, and a
//! second plain field `cap` exists so "select one field, the sibling does
//! NOT light" is observable on the same type.
pub mod core;

pub struct Vault {
    /// Struct field that COLLIDES with the `store()` method below. Shares
    /// the canonical id `sel_interactions::Vault::store`.
    pub store: u32,
    /// Plain sibling field — used to assert single-row selection.
    pub cap: u32,
    /// Field that owns `core::Box_`, so the type emits an ownership arrow.
    pub boxed: core::Box_,
}

impl Vault {
    /// Inherent method whose NAME collides with the `store` field. Same
    /// canonical id, different kind.
    pub fn store(&self) -> u32 {
        self.store
    }

    /// A second method so the `pub fn` bucket is unambiguously non-empty.
    pub fn capacity(&self) -> u32 {
        self.cap
    }
}
