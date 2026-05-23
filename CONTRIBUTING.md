# Contributing to mind-expander

Thanks for the interest. Contributions of any size are welcome — bug
reports, doc fixes, new fact extractors, new visualizations, agent
skill improvements.

## Quick start

```sh
git clone https://github.com/mbbill/mind-expander
cd mind-expander
cargo build                 # builds the Rust binary + embeds the viewer
cargo test                  # 56 Rust tests
cd viewer && npm install && npm test   # 340 viewer tests
```

Then drive it on any repo:

```sh
cargo run -- view /path/to/some/codebase
```

## Where things live

| Area | Path |
|---|---|
| Rust fact extractor + CLI | `src/` |
| Rust language frontend | `src/frontend/rust.rs` |
| TypeScript language frontend | `src/frontend/typescript.rs` |
| HTTP server (`view` subcommand) | `src/server.rs` |
| Browser app (D3 + TS) | `viewer/src/` |
| AI agent skill | `skill/mind-expander.md` |
| npm packaging | `npm/` |
| Release tooling | `scripts/release.sh`, `.github/workflows/release.yml` |

## Submitting changes

1. Fork the repo, create a feature branch from `main`.
2. Make your change. Keep PRs focused — small, single-purpose
   changes review faster than sprawling ones.
3. Run the test suites locally:
   ```sh
   cargo fmt --all -- --check
   cargo clippy --all-targets
   cargo test --all-targets
   (cd viewer && npm test)
   ```
4. Open a PR. The CI workflow re-runs the same checks on a clean
   environment.

## Adding a new language frontend

The architecture is designed for this. See `src/frontend.rs` for the
`LanguageFrontend` trait and `src/frontend/rust.rs` /
`src/frontend/typescript.rs` for working examples. The trait is
small (one method); the heavy lifting is the language-specific AST
walking that produces `WorkspaceFacts`.

## Reporting bugs

[Open an issue](https://github.com/mbbill/mind-expander/issues) with:
- What you ran (full command line)
- What you expected
- What happened (paste any error output)
- Your platform (`uname -a` + Node/Rust versions)

A minimal reproducer makes the bug 10x easier to fix.

## License

By contributing, you agree your contributions are licensed under
[Apache-2.0](LICENSE), the same as the rest of the project.
