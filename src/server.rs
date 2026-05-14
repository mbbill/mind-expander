//! HTTP server for the `view` subcommand.
//!
//! Serves three things:
//!   - the embedded viewer bundle (HTML + assets) at `/`
//!   - `/api/facts` — JSON of facts extracted from the workspace
//!   - `/api/source?path=<abs>` — source-file streaming, sandboxed to
//!     the workspace root so the viewer can render the code panel.
//!
//! The Vite dev server proxies the two `/api/*` routes here during
//! viewer development; in production this binary serves everything.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use include_dir::{Dir, include_dir};
use serde::Deserialize;
use tokio::net::TcpListener;

// Embed the built viewer at compile time. `build.rs` checks that
// `viewer/dist/index.html` exists and fails the build with a helpful
// message if it's missing.
static VIEWER_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/viewer/dist");

struct AppState {
    facts_json: String,
    workspace_root: PathBuf,
}

pub fn run(workspace: &Path, port: u16, open_browser: bool) -> Result<()> {
    let workspace_root = std::fs::canonicalize(workspace)
        .with_context(|| format!("workspace path not found: {}", workspace.display()))?;

    eprintln!("Extracting facts from {} ...", workspace_root.display());
    let facts = crate::extract::extract_workspace(&workspace_root)?;
    let type_count: usize = facts
        .crates
        .values()
        .flat_map(|c| c.modules.values())
        .map(|m| m.types.len())
        .sum();
    let facts_json = serde_json::to_string(&facts)?;
    eprintln!(
        "Extracted {} types from {} crate(s).",
        type_count,
        facts.crates.len()
    );

    let state = Arc::new(AppState {
        facts_json,
        workspace_root,
    });

    let app = Router::new()
        .route("/api/facts", get(get_facts))
        .route("/api/source", get(get_source))
        .fallback(get(serve_static))
        .with_state(state);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let listener = TcpListener::bind(addr)
            .await
            .with_context(|| format!("failed to bind to {addr}"))?;
        let url = format!("http://{addr}/");
        eprintln!("mind-expander serving at {url}");
        if open_browser {
            if let Err(err) = opener::open_browser(&url) {
                eprintln!("(could not auto-open browser: {err})");
            }
        }
        axum::serve(listener, app).await?;
        Ok::<_, anyhow::Error>(())
    })?;
    Ok(())
}

async fn get_facts(State(state): State<Arc<AppState>>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        state.facts_json.clone(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct SourceQuery {
    path: String,
}

async fn get_source(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SourceQuery>,
) -> Response {
    // Accept absolute paths as-is; resolve relative paths against the
    // workspace root. Either way, canonicalize and verify the result
    // stays inside the workspace before reading. This is the same
    // sandbox shape the Vite plugin used to implement.
    let candidate = if Path::new(&q.path).is_absolute() {
        PathBuf::from(&q.path)
    } else {
        state.workspace_root.join(&q.path)
    };
    let real = match std::fs::canonicalize(&candidate) {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !real.starts_with(&state.workspace_root) {
        return (StatusCode::FORBIDDEN, "outside workspace").into_response();
    }
    let meta = match std::fs::metadata(&real) {
        Ok(m) => m,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !meta.is_file() {
        return (StatusCode::BAD_REQUEST, "not a file").into_response();
    }
    match std::fs::read(&real) {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("read error: {err}"),
        )
            .into_response(),
    }
}

async fn serve_static(uri: axum::http::Uri) -> Response {
    // Single-page app: every non-asset path falls back to index.html so
    // the viewer's own routing (if any) keeps working.
    let path = uri.path().trim_start_matches('/');
    let lookup = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = VIEWER_DIST.get_file(lookup) {
        let mime = mime_for(lookup);
        return ([(header::CONTENT_TYPE, mime)], file.contents()).into_response();
    }
    if let Some(file) = VIEWER_DIST.get_file("index.html") {
        return (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            file.contents(),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "viewer bundle missing").into_response()
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}
