//! Integration test for the TypeScript frontend.
//!
//! Drives the binary end-to-end against `tests/fixtures/typescript/`
//! and asserts on the extracted JSON. This is intentionally a black-box
//! test — it shells out to the binary the user actually runs, so a
//! regression in CLI wiring or output format also gets caught here.

use std::process::Command;

use serde_json::Value;

/// Path to the built `mind-expander` binary. Cargo populates this
/// env var at test-binary compile time.
const BIN: &str = env!("CARGO_BIN_EXE_mind-expander");

fn extract_ts_fixture() -> Value {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("typescript");
    let out = Command::new(BIN)
        .args([
            "--root",
            fixture.to_str().unwrap(),
            "--lang",
            "typescript",
            "extract",
        ])
        .output()
        .expect("running mind-expander binary");
    assert!(
        out.status.success(),
        "extract failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("output is JSON")
}

#[test]
fn ts_fixture_extracts_all_kinds() {
    let facts = extract_ts_fixture();
    let crate_facts = &facts["crates"]["ts-fixture"];
    let module = &crate_facts["modules"][""];
    let types = module["types"].as_array().expect("types array");

    let kinds_present: std::collections::BTreeSet<&str> =
        types.iter().filter_map(|t| t["kind"].as_str()).collect();
    for expected in ["class", "interface", "type_alias", "enum"] {
        assert!(
            kinds_present.contains(expected),
            "fixture missing TypeKind={expected}; got {kinds_present:?}",
        );
    }
}

#[test]
fn ts_fixture_emits_extends_and_implements_edges() {
    let facts = extract_ts_fixture();
    let edges = facts["edges"].as_array().expect("edges array");

    let has = |from: &str, to: &str, kind: &str| {
        edges.iter().any(|e| {
            e["from"].as_str() == Some(from)
                && e["to"].as_str() == Some(to)
                && e["kind"].as_str() == Some(kind)
        })
    };

    // class extends class → kind=extends (not trait_impl)
    assert!(
        has("ts-fixture::AuthServer", "ts-fixture::Server", "extends"),
        "missing extends edge AuthServer → Server"
    );
    // class implements interface → kind=trait_impl
    assert!(
        has("ts-fixture::Server", "ts-fixture::Handler", "trait_impl"),
        "missing trait_impl edge Server → Handler"
    );
    // interface extends interface → kind=trait_impl (shape merge)
    assert!(
        has(
            "ts-fixture::AdminHandler",
            "ts-fixture::Handler",
            "trait_impl"
        ),
        "missing trait_impl edge AdminHandler → Handler"
    );
}

#[test]
fn ts_fixture_field_cardinalities_are_correct() {
    let facts = extract_ts_fixture();
    let edges = facts["edges"].as_array().expect("edges array");

    let card_of = |from: &str, to: &str| -> Option<String> {
        edges
            .iter()
            .find(|e| e["from"].as_str() == Some(from) && e["to"].as_str() == Some(to))
            .and_then(|e| e["cardinality"].as_str().map(|s| s.to_string()))
    };

    // Server.routes: Route[]  → many
    assert_eq!(
        card_of("ts-fixture::Server", "ts-fixture::Route").as_deref(),
        Some("many"),
        "routes: Route[] should be cardinality=many"
    );
    // Server.active: Set<Request> → many (Set descended; Set itself filtered)
    assert_eq!(
        card_of("ts-fixture::Server", "ts-fixture::Request").as_deref(),
        Some("many"),
        "active: Set<Request> should be cardinality=many"
    );
    // Route.handler: Handler → one
    assert_eq!(
        card_of("ts-fixture::Route", "ts-fixture::Handler").as_deref(),
        Some("one"),
        "handler: Handler should be cardinality=one"
    );
}

#[test]
fn ts_fixture_filters_container_builtins_from_edges() {
    let facts = extract_ts_fixture();
    let edges = facts["edges"].as_array().expect("edges array");
    for builtin in ["Map", "Set", "Array", "ReadonlyArray", "Promise"] {
        assert!(
            !edges.iter().any(|e| e["to"].as_str() == Some(builtin)),
            "edge to builtin container `{builtin}` leaked into output",
        );
    }
}
