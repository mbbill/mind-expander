#!/usr/bin/env node
//
// Launcher for the mind-expander Rust binary.
//
// npm installs the platform-specific binary as an optionalDependency
// (one of `@mind-expander/binary-*`). At runtime we map this
// process's platform + arch to the matching package name, resolve the
// binary inside that package's `bin/` directory, and exec it with
// the original argv forwarded through. Exit code is propagated so
// shell pipelines see the real status from the Rust process.
//
// The optionalDependencies approach means npm transparently skips
// installing binaries for platforms the user isn't on — install only
// downloads ~20MB, not ~100MB.

'use strict';

const { spawnSync } = require('node:child_process');

// Maps `${process.platform}-${process.arch}` to the npm package that
// ships the binary. Add new entries here as we expand target
// coverage (e.g. musl Linux, Windows ARM). Keep in sync with the
// `optionalDependencies` in this package's package.json and the
// matrix in `.github/workflows/release.yml`.
const PACKAGES = {
  'darwin-arm64': '@mind-expander/binary-darwin-arm64',
  'darwin-x64': '@mind-expander/binary-darwin-x64',
  'linux-x64': '@mind-expander/binary-linux-x64-gnu',
  'linux-arm64': '@mind-expander/binary-linux-arm64-gnu',
  'win32-x64': '@mind-expander/binary-win32-x64-msvc',
};

const key = `${process.platform}-${process.arch}`;
const pkg = PACKAGES[key];

if (!pkg) {
  // Print the actual platform+arch so a user opening an issue gives
  // us the information we need without a back-and-forth. Suggest the
  // build-from-source fallback in the same message.
  process.stderr.write(
    `mind-expander: no prebuilt binary for ${key}.\n` +
      `\n` +
      `Supported platforms:\n` +
      Object.keys(PACKAGES)
        .map((k) => `  - ${k}`)
        .join('\n') +
      `\n\n` +
      `Build from source as a fallback:\n` +
      `  cargo install --git https://github.com/mbbill/mind-expander\n` +
      `\n` +
      `Or open an issue requesting prebuilt support for ${key}:\n` +
      `  https://github.com/mbbill/mind-expander/issues\n`,
  );
  process.exit(1);
}

// `require.resolve` finds the binary inside the installed platform
// package, regardless of where npm put it in node_modules (root,
// nested, monorepo workspace, etc.). On missing — typically when
// optionalDependencies silently failed during install — we surface a
// targeted error instead of the cryptic MODULE_NOT_FOUND default.
const exeName =
  process.platform === 'win32' ? 'mind-expander.exe' : 'mind-expander';

let binaryPath;
try {
  binaryPath = require.resolve(`${pkg}/bin/${exeName}`);
} catch (err) {
  process.stderr.write(
    `mind-expander: failed to locate ${pkg}/bin/${exeName}.\n` +
      `\n` +
      `This usually means the optionalDependency didn't install.\n` +
      `Try reinstalling:\n` +
      `  npm install --force mind-expander\n` +
      `\n` +
      `Or build from source:\n` +
      `  cargo install --git https://github.com/mbbill/mind-expander\n`,
  );
  process.exit(1);
}

// `stdio: 'inherit'` so the Rust process owns the terminal directly —
// the ready-block, color codes, signals (Ctrl+C), etc. all flow
// through. Forward argv unchanged.
const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
});

// If the spawn itself failed (EACCES, ENOEXEC, ENOENT) `result.error`
// is set and `result.status` is null. With `stdio: 'inherit'` and no
// explicit error handling, these failures silently exit with status
// 1 — which is exactly how v0.1.0 shipped invisibly broken when the
// binary lost its +x bit in the artifact round-trip. Surface a
// targeted message instead.
if (result.error) {
  const err = result.error;
  let hint = '';
  if (err.code === 'EACCES') {
    hint =
      `\n  The binary exists but isn't executable. Try:\n` +
      `    chmod +x "${binaryPath}"\n` +
      `  If that fixes it, the package install is bugged — please file an issue.`;
  } else if (err.code === 'ENOENT') {
    hint =
      `\n  The binary path doesn't exist. The platform package may have been\n` +
      `  installed incompletely. Try reinstalling:\n` +
      `    npm install --force mind-expander`;
  } else if (err.code === 'ENOEXEC') {
    hint =
      `\n  The binary isn't a valid executable for this OS. This package was\n` +
      `  built for ${key} — check that matches your machine.`;
  }
  process.stderr.write(
    `mind-expander: failed to launch ${binaryPath}\n` +
      `  ${err.code ?? 'error'}: ${err.message}` +
      hint +
      `\n`,
  );
  process.exit(1);
}

// Bubble up signal exits so e.g. Ctrl+C in `mind-expander view`
// returns the conventional 130 instead of `null`.
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
