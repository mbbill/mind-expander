{
  "schemaVersion": 2,
  "title": "Agent Instructions",
  "scope": {
    "appliesTo": "whole_repository"
  },
  "requestProtocol": {
    "trivialRequests": {
      "instruction": "For trivial, low-risk requests, proceed directly while preserving local conventions."
    },
    "nonTrivialRequests": {
      "instruction": "For every non-trivial request, evaluate difficulty and scope before acting.",
      "beforeImplementation": [
        "Analyze the intended behavior and architecture comprehensively.",
        "Identify the module/layer that owns the behavior.",
        "Propose 2-3 viable solutions to the user.",
        "For each option, explain why it is clean up through the design level.",
        "For each option, explicitly state whether structural work or refactor is needed to preserve code quality."
      ]
    },
    "tradeoffs": {
      "instruction": "When an issue exposes an algorithm, architecture, or product-behavior tradeoff, do not take a conservative shortcut just to remove the symptom. Identify the intended solution and owning layer first. If the right solution is unclear or has meaningful tradeoffs, stop and discuss it before implementing."
    },
    "repeatedFailure": {
      "threshold": 3,
      "instruction": "If the same issue still fails after three fix attempts, stop making incremental patches. Re-examine the deeper architecture, algorithm, and product contract, then discuss the intended solution or necessary refactor before implementing another fix."
    }
  },
  "architecturePolicy": {
    "principle": "Preserve the architecture of the system while making changes. Do not add behavior by patching around bugs in unrelated layers.",
    "ownershipRequirement": "Before changing behavior, identify which layer owns it. If ownership is unclear, clarify or refactor the boundary before implementing behavior.",
    "layers": [
      {
        "id": "data_model",
        "label": "data/model",
        "owns": [
          "source facts",
          "normalized state",
          "indexes",
          "core domain invariants"
        ]
      },
      {
        "id": "analysis_logic",
        "label": "analysis/logic",
        "owns": [
          "derived behavior",
          "algorithms",
          "transformations",
          "computed relationships"
        ]
      },
      {
        "id": "ui_rendering",
        "label": "UI/rendering",
        "owns": [
          "presentation of already-computed state",
          "user interaction wiring"
        ]
      },
      {
        "id": "integration_adapters",
        "label": "integration/adapters",
        "owns": [
          "translating between external inputs/outputs and internal contracts"
        ]
      }
    ],
    "boundaryPolicy": "If behavior does not fit an existing layer cleanly, refactor the boundary first. Architecture cleanup has priority over adding another special case.",
    "contracts": {
      "instruction": "Prefer small, explicit contracts between modules over implicit coupling through shared implementation details."
    },
    "invariants": [
      "Existing feature behavior is preserved unless intentionally changed.",
      "Module boundaries remain clear and documented by the code structure.",
      "Internal data contracts stay consistent between producer and consumer.",
      "UI code does not compensate for bugs in lower-level data or logic unless the renderer is truly the owning layer."
    ]
  },
  "testingPolicy": {
    "bugFixes": "Add or update a focused test that would have caught the bug.",
    "largerBehaviorChanges": "Add invariant tests for behavior that must not regress.",
    "coverageExpectation": "Tests should cover the invariant or user-visible behavior being changed."
  },
  "implementationPolicy": {
    "scopeControl": "Do not add speculative features, diagnostics, UI affordances, or helpful extras that were not requested. If an addition seems useful but is not required for the current task, discuss it before implementing it.",
    "diagnostics": "Keep debug and diagnostic views driven by the same data structures used by the real implementation. Do not maintain separate approximate diagnostic data.",
    "comments": "When adding code for a specific feature or product behavior, include a nearby intent comment only when the behavior or constraint is not obvious from the code. Comments should explain why the code is needed and what behavior it protects, not restate the implementation line by line."
  }
}
