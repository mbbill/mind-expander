//! HTTP server for the `view` subcommand.
//!
//! Serves:
//!   - the embedded viewer bundle (HTML + assets) at `/`
//!   - `/api/health` — liveness probe used by the `tour` CLI
//!   - `/api/facts` — JSON of facts extracted from the workspace
//!   - `/api/source?path=<abs>` — source-file streaming, sandboxed to
//!     the workspace root so the viewer can render the code panel.
//!   - `/api/tour` (POST) — accept a tour JSON, validate + resolve it
//!     against the span index, and push the resolved form onto the
//!     in-memory queue (consumed later by the viewer's SSE channel).
//!
//! The Vite dev server proxies the `/api/*` routes here during viewer
//! development; in production this binary serves everything.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::stream::{Stream, StreamExt};
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::tour::{IngestErr, IngestOk, ResolveError, SpanIndex, Tour, TourQueue, ingest};

// Embed the built viewer at compile time. `build.rs` checks that
// `viewer/dist/index.html` exists and fails the build with a helpful
// message if it's missing.
static VIEWER_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/viewer/dist");

struct AppState {
    facts_json: String,
    workspace_root: PathBuf,
    /// Pre-built index used by `/api/tour` to resolve `{file, line}`
    /// refs in a tour to canonical `(elementId, kind)` pairs. Built
    /// once at startup so per-tour validation stays cheap.
    span_index: SpanIndex,
    tours: TourQueue,
    /// Fan-out for SSE subscribers. Each successful POST /api/tour
    /// is broadcast here; every active /api/tour-events stream pulls
    /// a fresh receiver and forwards events to its viewer.
    tour_tx: broadcast::Sender<crate::tour::ResolvedTour>,
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
    let span_index = SpanIndex::build(&facts);
    let facts_json = serde_json::to_string(&facts)?;
    eprintln!(
        "Extracted {} types from {} crate(s).",
        type_count,
        facts.crates.len()
    );

    // Capacity 16 = enough headroom for a burst of tours; if a
    // slow viewer falls more than that behind, BroadcastStream emits
    // a Lagged error which we drop silently (viewer can re-request
    // the latest tour later).
    let (tour_tx, _) = broadcast::channel::<crate::tour::ResolvedTour>(16);
    let state = Arc::new(AppState {
        facts_json,
        workspace_root,
        span_index,
        tours: TourQueue::default(),
        tour_tx,
    });

    let app = Router::new()
        .route("/api/health", get(get_health))
        .route("/api/facts", get(get_facts))
        .route("/api/source", get(get_source))
        .route("/api/tour", post(post_tour))
        .route("/api/tour-events", get(get_tour_events))
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

#[derive(Serialize)]
struct HealthBody<'a> {
    status: &'a str,
    workspace_root: &'a str,
}

async fn get_health(State(state): State<Arc<AppState>>) -> Response {
    Json(HealthBody {
        status: "ok",
        workspace_root: state.workspace_root.to_string_lossy().as_ref(),
    })
    .into_response()
}

#[derive(Serialize)]
#[serde(untagged)]
enum TourResponse {
    Ok {
        status: &'static str,
        tour_id: String,
    },
    Err {
        status: &'static str,
        errors: Vec<ResolveError>,
    },
}

async fn post_tour(
    State(state): State<Arc<AppState>>,
    Json(tour): Json<Tour>,
) -> Response {
    // Tour id is just a monotonic counter on the queue length; the
    // viewer's SSE consumer uses it to dedupe across reconnects.
    // Server restart resets the sequence — that's fine, we don't
    // persist tours.
    let tour_id = format!("tour:{}", state.tours.snapshot().len() + 1);
    match ingest(tour, &state.span_index, &state.workspace_root, tour_id.clone()) {
        Ok(IngestOk { resolved }) => {
            state.tours.push(resolved.clone());
            // Send to any live SSE subscribers. `send` only errors
            // when there are zero receivers — that just means no
            // viewer is open; the queue still holds the tour for
            // when one connects.
            let _ = state.tour_tx.send(resolved);
            (
                StatusCode::OK,
                Json(TourResponse::Ok {
                    status: "ok",
                    tour_id,
                }),
            )
                .into_response()
        }
        Err(IngestErr { errors }) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(TourResponse::Err {
                status: "err",
                errors,
            }),
        )
            .into_response(),
    }
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

async fn get_tour_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tour_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        // Drop Lagged errors silently — they mean the viewer is too
        // slow to keep up. The viewer can hit GET /api/tours later if
        // we need a recovery path; for the notification feature
        // missing a tick is harmless.
        let tour = msg.ok()?;
        Some(Ok::<Event, Infallible>(
            Event::default()
                .event("tour")
                .json_data(&tour)
                .unwrap_or_else(|_| Event::default()),
        ))
    });
    // Periodic comments keep proxies and the browser from closing an
    // idle connection. 15 s is well under the conventional 60 s
    // proxy timeout.
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}
