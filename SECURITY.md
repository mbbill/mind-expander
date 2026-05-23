# Security Policy

## Reporting a vulnerability

If you find a security issue in mind-expander, please report it
privately rather than in a public issue:

- **GitHub Security Advisories** (preferred): use the
  [Report a vulnerability](https://github.com/mbbill/mind-expander/security/advisories/new)
  button on the repo's Security tab. This gives us a private channel
  to triage + coordinate disclosure.
- **Email**: as a fallback, mbbill@gmail.com.

Please include enough detail to reproduce the issue (command line,
input data, observed behavior). I'll acknowledge within a few
business days.

## What counts

mind-expander runs locally — a CLI plus an HTTP server bound to
localhost. Areas where a security report is meaningful:

- Path traversal or arbitrary file read via crafted workspace
  paths, tour JSON, or `--at` revspecs
- SSRF / network egress that should not happen from local-only
  workflows
- The local HTTP server accepting connections from non-loopback
  addresses, or leaking source content beyond the workspace root
- Skill-install paths writing outside the documented agent config
  directories
- Dependency vulnerabilities in shipped binaries (npm or crates)

## Out of scope

- Bugs that require an attacker with arbitrary local file write
  access (they already own the machine)
- Browser sandbox bypasses inside the viewer's iframe — the viewer
  shows your own source, by design
- Anything in the skill content (it's instructions for an AI, not
  executable code)

## Coordinated disclosure

Once a fix is ready, I'll publish a patch release and a security
advisory crediting the reporter (unless they prefer to stay
anonymous).
