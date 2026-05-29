//! Black-box integration test for the live-reload feature.
//!
//! Spawns the actual `view` server against an isolated temp workspace,
//! waits for the ready event, then writes a real source change and
//! asserts the server emits a `facts_updated` stdout line — the
//! server→agent half of the wire contract the viewer depends on.
//!
//! Uses a fresh `tempfile::tempdir()` rather than the git-tracked
//! `tests/fixtures/typescript` so it never races the byte-identity
//! test (cargo runs integration tests in parallel) and never leaves
//! the working tree dirty. `view` never exits, so we stream stdout
//! line-by-line with a reader thread instead of `Command::output()`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_mind-expander");

/// Spawn `view <dir> --port 0`, returning the child plus a channel of
/// parsed stdout JSON-event objects. A background reader thread feeds
/// the channel so the test never blocks the child's stdout pipe.
fn spawn_view(dir: &std::path::Path) -> (Child, mpsc::Receiver<serde_json::Value>) {
    let mut child = Command::new(BIN)
        .arg("view")
        .arg(dir)
        .args(["--port", "0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawning `view`");
    let stdout = child.stdout.take().expect("child stdout");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if tx.send(v).is_err() {
                    return; // receiver dropped → test finished
                }
            }
        }
    });
    (child, rx)
}

/// Block until an event whose `"event"` field equals `name` arrives, or
/// `deadline` elapses.
fn wait_for_event(
    rx: &mpsc::Receiver<serde_json::Value>,
    name: &str,
    timeout: Duration,
) -> Option<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(remaining) {
            Ok(v) => {
                if v.get("event").and_then(|e| e.as_str()) == Some(name) {
                    return Some(v);
                }
            }
            Err(_) => return None,
        }
    }
    None
}

#[test]
fn working_tree_edit_emits_facts_updated() {
    // Minimal Rust crate so the extractor finds a source package
    // (`Cargo.toml` with `[package]` + a `src/` dir of `.rs` files).
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"live_reload_fixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\n",
    )
    .expect("write Cargo.toml");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("create src dir");
    let src = src_dir.join("lib.rs");
    std::fs::write(&src, "pub struct Alpha;\n").expect("write initial source");

    let (mut child, rx) = spawn_view(dir.path());

    // Ready first — the server only watches after startup completes.
    let ready = wait_for_event(&rx, "ready", Duration::from_secs(30));
    assert!(
        ready.is_some(),
        "server never emitted a ready event (full output may indicate a spawn failure)"
    );

    // Write a REAL byte change. The facts cache keys on mtime+size, so
    // appending a new entity guarantees cache invalidation and a
    // non-trivial re-extract — a bare touch would not.
    {
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&src)
            .expect("reopen source for append");
        writeln!(f, "pub struct Beta;").expect("append source");
        f.flush().expect("flush");
    }

    // Debounce is ~300ms; allow generous slack for a cold extract.
    let updated = wait_for_event(&rx, "facts_updated", Duration::from_secs(30));

    // Tear the child down before asserting so a failure doesn't leak a
    // running server (tempdir auto-deletes on drop).
    let _ = child.kill();
    let _ = child.wait();

    let updated = updated.expect("server never emitted facts_updated after a source edit");
    // Wire-contract shape: counts present and non-negative integers.
    assert!(
        updated.get("type_count").and_then(|v| v.as_u64()).is_some(),
        "facts_updated missing type_count: {updated}"
    );
    assert!(
        updated
            .get("crate_count")
            .and_then(|v| v.as_u64())
            .is_some(),
        "facts_updated missing crate_count: {updated}"
    );
}
