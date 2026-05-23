// The `view` subcommand embeds the built viewer (`viewer/dist/`) into
// the binary at compile time via `include_dir!`. This build script
// keeps the bundle in sync with the viewer sources, so a plain
// `cargo build` is enough — no separate `npm run build` step.
//
// Strategy: collect the newest mtime across every input that
// affects the viewer bundle (sources, config, lockfile), compare with
// the bundle's own mtime, and run `npm install` + `npm run build` if
// the bundle is missing or stale. The mtime check is cheap; npm only
// fires when something actually changed.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let viewer = manifest_dir.join("viewer");
    let dist_index = viewer.join("dist").join("index.html");

    // Inputs that should trigger a viewer rebuild. We walk `src/`
    // recursively; the other entries are flat files.
    let mut inputs: Vec<PathBuf> = Vec::new();
    collect_files(&viewer.join("src"), &mut inputs);
    for flat in [
        "index.html",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "vite.config.ts",
    ] {
        let p = viewer.join(flat);
        if p.exists() {
            inputs.push(p);
        }
    }

    // Tell cargo to re-run if any tracked input changes. Without this,
    // cargo would not invoke build.rs again on a frontend-only edit.
    for p in &inputs {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    println!("cargo:rerun-if-changed=build.rs");

    let newest_input = inputs
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok()?.modified().ok())
        .max();
    let dist_mtime = std::fs::metadata(&dist_index)
        .ok()
        .and_then(|m| m.modified().ok());

    let needs_build = match (newest_input, dist_mtime) {
        (_, None) => true,                     // dist missing
        (Some(src), Some(dist)) => src > dist, // any input is newer
        (None, Some(_)) => false,              // nothing to compare; trust dist
    };

    if !needs_build {
        return;
    }

    eprintln!("mind-expander: viewer bundle is stale, rebuilding...");

    let node_modules = viewer.join("node_modules");
    if !node_modules.exists() {
        eprintln!("mind-expander: installing viewer deps (npm ci)...");
        run_npm(&viewer, &["ci"]);
    }

    eprintln!("mind-expander: building viewer (npm run build)...");
    run_npm(&viewer, &["run", "build"]);

    if !dist_index.exists() {
        panic!(
            "viewer build finished but {} is missing — check the npm output above",
            dist_index.display()
        );
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_files(&path, out),
            Ok(t) if t.is_file() => out.push(path),
            _ => {}
        }
    }
}

fn run_npm(cwd: &Path, args: &[&str]) {
    // Spell `npm` so this works on Windows too without forcing users
    // to install a unix shell.
    let cmd = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap_or_else(|err| {
            panic!(
                "failed to invoke `{cmd} {}` in {}: {err}\n\
                 Install Node.js (https://nodejs.org/) or build the viewer manually:\n  \
                 npm --prefix viewer ci && npm --prefix viewer run build",
                args.join(" "),
                cwd.display(),
            )
        });
    if !status.success() {
        panic!(
            "`{cmd} {}` in {} exited with {status}",
            args.join(" "),
            cwd.display(),
        );
    }
}
