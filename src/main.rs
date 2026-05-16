//! Codebase fact extractor.
//!
//! Walks Rust source under one or more crate roots, parses with `syn`, and
//! emits a JSON document of per-type facts plus a global edge graph. The
//! output is deliberately label-free: facts only, the user reads the role.

mod architecture;
mod callgraph;
mod extract;
mod model;
mod ownership;
mod print;
mod resolve;
mod server;
mod survey;
mod tour;
mod tour_client;
mod unified;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "mind-expander",
    version,
    about = "Extract ownership facts from a Rust workspace"
)]
struct Cli {
    /// Workspace root (defaults to current directory).
    #[arg(long, default_value = ".")]
    root: PathBuf,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Extract facts and write JSON to stdout (or --out).
    Extract {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Print a human-readable digest filtered by module-path prefix.
    Digest {
        /// Module path prefix, e.g. `sf-nano-core::vm::wasm`. Empty = all.
        #[arg(long, default_value = "")]
        module: String,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the unified module-and-ownership view. Default mode is a
    /// drift report — every type whose actual module disagrees with the
    /// LCA of its owners' modules. Pass --full for the complete outline
    /// with every type's classification annotated.
    Drift {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Maximum levels a type may live below the LCA before counting
        /// as drift. 0 = strict, 1 = default (one folder of slack).
        #[arg(long, default_value_t = 1)]
        max_below_lca: u32,
        /// Count enum-variant payloads as ownership too. Default false:
        /// sum-composition pulls payload types' LCAs to the crate root,
        /// which is not what the analysis is asking about.
        #[arg(long)]
        include_variants: bool,
        /// Print the full unified outline instead of the drift-only report.
        #[arg(long)]
        full: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the module-level architecture: per-module size, outbound
    /// imports, inbound dependents (with edge counts and kind breakdown),
    /// and any cycles (SCCs of size > 1). Tests modules and inter-crate
    /// edges are excluded.
    Arch {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Print the structural-ownership forest. By default uses only struct
    /// and union field edges; pass --include-variants to also follow enum
    /// variant payloads. Marks multi-owned nodes with ⊕ and re-encountered
    /// nodes with ↑. No labels.
    Tree {
        /// Optional crate name filter.
        #[arg(long)]
        krate: Option<String>,
        /// Also follow enum variant payloads when computing the forest.
        #[arg(long)]
        include_variants: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
    /// Extract facts and serve the interactive viewer in your browser.
    /// One-stop command for end users: no separate extract step, no
    /// Node toolchain needed. Workspace path is the same `--root` as
    /// other subcommands, but accepted positionally here for ergonomics.
    View {
        /// Workspace root to extract and visualize. Defaults to the
        /// global `--root` if omitted.
        workspace: Option<PathBuf>,
        /// Port to bind the local server to.
        #[arg(long, default_value_t = 5180)]
        port: u16,
        /// Don't try to open the browser automatically.
        #[arg(long)]
        no_open: bool,
    },
    /// Send a tour JSON to a running `mind-expander view` server.
    /// `file` is a path; `-` reads JSON from stdin. The server
    /// validates the schema, resolves every `{file, line}` reference
    /// to a canonical element, and queues the resolved tour for the
    /// viewer to play. Prints `ok` on success or one error per line
    /// from the server's resolution failures.
    Tour {
        /// Path to a tour JSON, or `-` to read from stdin.
        file: PathBuf,
        /// Server to send the tour to, `host:port`. The LLM that
        /// started the server already knows this.
        #[arg(long)]
        host: String,
    },
    /// Print a compact, label-free survey: counters, module table,
    /// rankings, isolated types, lifetime-declaring types, unsafe locations,
    /// trait-impls. Designed for fast orientation without reading source.
    Survey {
        /// Optional crate name filter (matches the [package].name field).
        #[arg(long)]
        krate: Option<String>,
        /// Cap rows in ranking sections.
        #[arg(long, default_value_t = 20)]
        top: usize,
        /// Also print one line per type (suppressed by default — large crates
        /// produce hundreds of lines).
        #[arg(long)]
        types: bool,
        /// Optional: read from previously-extracted JSON instead of re-parsing.
        #[arg(long)]
        from: Option<PathBuf>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Extract { out } => {
            let facts = extract::extract_workspace(&cli.root)?;
            let json = serde_json::to_string_pretty(&facts)?;
            if let Some(path) = out {
                std::fs::write(path, json)?;
            } else {
                println!("{json}");
            }
        }
        Cmd::Digest { module, from } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract::extract_workspace(&cli.root)?
            };
            print::digest(&facts, &module);
        }
        Cmd::Drift {
            krate,
            max_below_lca,
            include_variants,
            full,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract::extract_workspace(&cli.root)?
            };
            let policy = unified::Policy {
                max_below_lca,
                include_variants,
            };
            unified::print(&facts, krate.as_deref(), &policy, full);
        }
        Cmd::Arch { krate, from } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract::extract_workspace(&cli.root)?
            };
            architecture::print(&facts, krate.as_deref());
        }
        Cmd::Tree {
            krate,
            include_variants,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract::extract_workspace(&cli.root)?
            };
            ownership::print_tree(&facts, krate.as_deref(), include_variants);
        }
        Cmd::View {
            workspace,
            port,
            no_open,
        } => {
            let path = workspace.unwrap_or(cli.root);
            server::run(&path, port, !no_open)?;
        }
        Cmd::Tour { file, host } => {
            tour_client::send(&file, &host)?;
        }
        Cmd::Survey {
            krate,
            top,
            types,
            from,
        } => {
            let facts = if let Some(path) = from {
                let s = std::fs::read_to_string(path)?;
                serde_json::from_str(&s)?
            } else {
                extract::extract_workspace(&cli.root)?
            };
            survey::survey(&facts, krate.as_deref(), top, types);
        }
    }
    Ok(())
}
