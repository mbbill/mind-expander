# Agent Instructions

These instructions apply to the whole repository.

## Engineering Discipline

- Preserve the architecture of the system while making changes. Do not add behavior by patching around the current bug in unrelated layers.
- Before adding a feature or fixing a bug, first identify the module/layer that owns the behavior. Do not implement the change until the ownership is clear. If the behavior does not fit cleanly in the current structure, refactor the boundary first; do not hide the mismatch with a local workaround.
- Prefer small, explicit contracts between modules over implicit coupling through shared implementation details.
- Any bug fix should add or update a focused test that would have caught the bug.
- Any larger behavior change should include invariant tests for the behavior that must not regress.
- When adding code for a specific feature or product behavior, include a nearby comment explaining why the code is needed and what behavior it protects. Keep the comment focused on intent and constraints, not a line-by-line restatement of the code.
- Do not compensate for lower-layer bugs in rendering or UI event handlers unless the renderer is truly the owning layer.
- Keep debug and diagnostic views driven by the same data structures used by the real implementation. Do not maintain separate approximate diagnostic data.
- Do not add speculative features, diagnostics, UI affordances, or "helpful" extras that were not requested. If an addition seems useful but is not required for the current task, discuss it first instead of implementing it.
- When an issue exposes an algorithm, architecture, or product-behavior tradeoff, do not immediately take a conservative shortcut just to make the symptom go away. First identify the best intended solution and the owning layer. If the right solution is unclear or has meaningful tradeoffs, stop and discuss it before implementing.

## Change Ownership Rule

Changes must preserve the architecture of the area they touch. Do not add behavior by patching around a bug inside unrelated modules, UI layers, adapters, or call sites.

Before changing behavior, identify which layer owns it:

- data/model: source facts, normalized state, indexes, and core domain invariants.
- analysis/logic: derived behavior, algorithms, transformations, and computed relationships.
- UI/rendering: presentation of already-computed state and user interaction wiring.
- integration/adapters: translating between external inputs/outputs and internal contracts.

If the behavior does not fit an existing layer cleanly, refactor the boundary first. Architecture cleanup has priority over adding another special case.

Changes must preserve relevant invariants unless the change explicitly updates product behavior:

- Existing feature behavior is preserved unless intentionally changed.
- Module boundaries remain clear and documented by the code structure.
- Internal data contracts stay consistent between producer and consumer.
- Debug and diagnostic output reflects the real implementation data.
- UI code does not compensate for bugs in lower-level data or logic.
- Tests cover the invariant or user-visible behavior being changed.

## Change Checklist

Use this checklist for any non-trivial change:

- Which layer owns this behavior?
- Did this avoid adding logic to an unrelated module or call site?
- Did this add or update an invariant test?
- Did this preserve existing feature behavior that is not part of the change?
- Did this keep producer/consumer contracts explicit?
- Did feature-specific code include a nearby intent comment?
- If the architecture was unclear, was the boundary refactored before adding feature logic?
- If there was a difficult tradeoff, did this avoid a conservative shortcut and either implement the intended solution or discuss the uncertainty first?
