//! `mind-expander tour <file> --host host:port` — send a tour JSON to
//! a running server.
//!
//! Reads the file (or stdin if `file` is `-`), POSTs it to the
//! server's `/api/tour`, and prints either `ok` or one structured
//! error per failed step. Exit code mirrors success: `0` on `ok`,
//! non-zero on any failure (including transport/validation issues).
//!
//! Kept tiny on purpose — `ureq` is sync, deps-light, and the whole
//! interaction is one request/response.

use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;

pub fn send(file: &Path, host: &str) -> Result<()> {
    let body = read_body(file)?;
    let url = format!("http://{host}/api/tour");

    let response = ureq::post(&url)
        .set("content-type", "application/json")
        .send_string(&body);

    match response {
        Ok(resp) => handle_response(resp.status(), resp.into_string()?),
        Err(ureq::Error::Status(code, resp)) => handle_response(code, resp.into_string()?),
        Err(ureq::Error::Transport(t)) => Err(anyhow!(
            "could not reach {url}: {t}. Is `mind-expander view ...` running on {host}?"
        )),
    }
}

fn read_body(file: &Path) -> Result<String> {
    if file == Path::new("-") {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("reading tour from stdin")?;
        return Ok(buf);
    }
    std::fs::read_to_string(file)
        .with_context(|| format!("reading tour from {}", file.display()))
}

#[derive(Deserialize)]
struct OkBody {
    #[allow(dead_code)]
    status: String,
    tour_id: String,
}

#[derive(Deserialize)]
struct ErrBody {
    #[allow(dead_code)]
    status: String,
    errors: Vec<ServerError>,
}

#[derive(Deserialize)]
struct ServerError {
    /// 0 for the top-level `subject`; ≥1 indexes into `steps`.
    step: usize,
    /// 0 for "the step itself"; ≥1 indexes into `refs`.
    r#ref: usize,
    msg: String,
}

fn handle_response(status: u16, body: String) -> Result<()> {
    if status == 200 {
        let ok: OkBody = serde_json::from_str(&body)
            .with_context(|| format!("server returned 200 but body wasn't OkBody: {body}"))?;
        println!("ok ({})", ok.tour_id);
        return Ok(());
    }
    if status == 422 {
        let err: ErrBody = serde_json::from_str(&body).with_context(|| {
            format!("server returned 422 but body wasn't ErrBody: {body}")
        })?;
        for e in &err.errors {
            eprintln!("err: step={} ref={} {}", e.step, e.r#ref, e.msg);
        }
        return Err(anyhow!("tour rejected ({} error(s))", err.errors.len()));
    }
    Err(anyhow!(
        "server returned unexpected status {status}: {body}"
    ))
}
