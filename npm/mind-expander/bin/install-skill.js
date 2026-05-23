//
// `mind-expander install-skill` — detects which AI coding agents the
// user has installed, then copies the bundled skill file into the
// right path for each. Idempotent: re-running updates the installed
// copy in place (and replaces, not duplicates, any prior install).
//
// The skill file itself is the same `skill/mind-expander.md` that
// ships in this npm package via the `prepack` script in package.json.
//
// Per-agent install paths:
//   Claude Code  → ~/.claude/skills/mind-expander.md   (flat file)
//   Codex        → ~/.codex/AGENTS.md                  (marker-fenced append)
//   Cursor       → .cursor/rules/mind-expander.md      (project-level)
//
// The Claude Code path is user-level (works across all projects) since
// most users will want mind-expander available globally. Cursor's
// `.cursor/rules/` is project-local because Cursor doesn't have a
// clean user-level skills concept. Codex's AGENTS.md is user-level
// because Codex looks there for global instructions; the file may
// already exist with the user's own content, so we fence our block
// with HTML comment markers so subsequent re-installs replace cleanly.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// The bundled skill file. In a published install, prepack copies the
// repo's `skill/mind-expander.md` into `<pkg>/skill/`. In a source
// checkout (before prepack runs) it still lives at the repo root,
// two levels up from this script. Try both so the command works
// either way — useful for smoke-testing without a publish round-trip.
const SKILL_CANDIDATES = [
  path.join(__dirname, '..', 'skill', 'mind-expander.md'),
  path.join(__dirname, '..', '..', '..', 'skill', 'mind-expander.md'),
];
const SKILL_SOURCE =
  SKILL_CANDIDATES.find((p) => fs.existsSync(p)) ?? SKILL_CANDIDATES[0];

// Each target describes one agent we know how to install to. `detect`
// returns whether the agent appears to be present on this machine;
// `install` does the actual copy/write and returns the path written.
function buildTargets() {
  const home = os.homedir();
  const cwd = process.cwd();
  return [
    {
      name: 'Claude Code',
      scope: 'user',
      detect: () => fs.existsSync(path.join(home, '.claude')),
      describe: () => path.join(home, '.claude', 'skills', 'mind-expander.md'),
      install: (skill) => {
        const dir = path.join(home, '.claude', 'skills');
        const dest = path.join(dir, 'mind-expander.md');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, skill);
        return dest;
      },
    },
    {
      name: 'Codex',
      scope: 'user',
      detect: () => fs.existsSync(path.join(home, '.codex')),
      describe: () => path.join(home, '.codex', 'AGENTS.md') + ' (appended)',
      install: (skill) => {
        // Codex's AGENTS.md is a single combined-instructions file.
        // We append our block with HTML-comment markers so any prior
        // install can be cleanly replaced on re-run without
        // duplicating, and so users can hand-edit around our block
        // without our updates clobbering theirs.
        const dest = path.join(home, '.codex', 'AGENTS.md');
        const START = '<!-- mind-expander:start -->';
        const END = '<!-- mind-expander:end -->';
        let existing = '';
        if (fs.existsSync(dest)) {
          existing = fs.readFileSync(dest, 'utf8');
          const s = existing.indexOf(START);
          const e = existing.indexOf(END);
          if (s !== -1 && e !== -1 && e > s) {
            existing =
              existing.slice(0, s).trimEnd() +
              existing.slice(e + END.length);
          }
        }
        const block = `\n\n${START}\n${skill.trim()}\n${END}\n`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, existing.trimEnd() + block);
        return dest;
      },
    },
    {
      name: 'Cursor',
      scope: 'project',
      detect: () =>
        fs.existsSync(path.join(cwd, '.cursor')) ||
        fs.existsSync(path.join(cwd, '.cursorrules')),
      describe: () => path.join(cwd, '.cursor', 'rules', 'mind-expander.md'),
      install: (skill) => {
        const dir = path.join(cwd, '.cursor', 'rules');
        const dest = path.join(dir, 'mind-expander.md');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, skill);
        return dest;
      },
    },
  ];
}

function ask(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
}

async function main() {
  if (!fs.existsSync(SKILL_SOURCE)) {
    // Would only happen if someone ran us out of a broken/stripped
    // install where prepack didn't bundle the skill file.
    process.stderr.write(
      `install-skill: bundled skill file not found at ${SKILL_SOURCE}\n` +
        `This is a packaging bug — please file an issue.\n`,
    );
    process.exit(1);
  }
  const skill = fs.readFileSync(SKILL_SOURCE, 'utf8');

  const targets = buildTargets();
  const detected = targets.filter((t) => t.detect());

  if (detected.length === 0) {
    process.stdout.write(
      `mind-expander install-skill\n\n` +
        `No supported agents detected on this machine.\n` +
        `Looked for: ~/.claude/, ~/.codex/, .cursor/ (in current directory).\n\n` +
        `If you have an agent installed in a non-standard location, copy\n` +
        `the bundled skill file manually:\n\n` +
        `  ${SKILL_SOURCE}\n`,
    );
    return;
  }

  process.stdout.write(
    `mind-expander install-skill\n\n` +
      `Detected ${detected.length} agent${detected.length === 1 ? '' : 's'}:\n`,
  );
  for (const t of detected) {
    process.stdout.write(`  • ${t.name} (${t.scope}) → ${t.describe()}\n`);
  }
  process.stdout.write('\n');

  for (const t of detected) {
    const ans = await ask(`Install skill to ${t.name}? [Y/n] `);
    if (ans !== '' && ans !== 'y' && ans !== 'yes') {
      process.stdout.write(`  skipped\n\n`);
      continue;
    }
    try {
      const dest = t.install(skill);
      process.stdout.write(`  ✓ wrote ${dest}\n\n`);
    } catch (err) {
      process.stderr.write(`  ✗ failed: ${err.message}\n\n`);
    }
  }

  process.stdout.write(
    `Done. Re-run \`npx mind-expander install-skill\` after upgrading\n` +
      `the package to refresh the installed skill file.\n`,
  );
}

module.exports = main;
