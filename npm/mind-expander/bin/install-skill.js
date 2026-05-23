//
// `mind-expander install-skill` — detects which AI coding agents the
// user has installed, then writes the bundled skill file into the
// right per-agent path for each. Idempotent: re-running updates the
// installed copy in place, and cleans up the broken v0.1.2 install
// paths if present.
//
// The skill file itself is the same `skill/mind-expander.md` that
// ships in this npm package via the `prepack` script in package.json.
//
// Per-agent install paths (verified against current docs, May 2026):
//
//   Claude Code  → ~/.claude/skills/mind-expander/SKILL.md
//                  Directory-per-skill, filename must be SKILL.md
//                  (uppercase). Auto-discovered on session start.
//                  Source: code.claude.com/docs/en/skills.md
//
//   Codex        → ~/.agents/skills/mind-expander/SKILL.md
//                  Skills live in ~/.agents/ (NOT ~/.codex/) per the
//                  cross-vendor agents-spec. Codex's ~/.codex/ holds
//                  CLI state and AGENTS.md, both unrelated to skills.
//                  Source: developers.openai.com/codex/skills
//
//   Cursor       → .cursor/rules/mind-expander.mdc
//                  Project-level only. The .mdc extension (not .md)
//                  is required for the documented format and enables
//                  the frontmatter-driven activation modes. There is
//                  no user-global rules file path — global rules are
//                  GUI-only via Cursor Settings, so an installer
//                  can't write them.
//                  Source: cursor.com/docs/context/rules
//
// v0.1.2 broken-install cleanup: the previous version wrote to the
// wrong path for all three. Each target below also removes the
// corresponding v0.1.2 artifact before writing the correct one, so
// a `npx mind-expander install-skill` upgrade leaves no orphans.

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

// Delete a file if it exists; swallow ENOENT but surface other errors
// so we don't silently mask a permission problem.
function tryUnlink(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return false;
  }
}

function buildTargets() {
  const home = os.homedir();
  const cwd = process.cwd();
  return [
    {
      name: 'Claude Code',
      scope: 'user',
      detect: () => fs.existsSync(path.join(home, '.claude')),
      describe: () =>
        path.join(home, '.claude', 'skills', 'mind-expander', 'SKILL.md'),
      install: (skill) => {
        const dir = path.join(home, '.claude', 'skills', 'mind-expander');
        const dest = path.join(dir, 'SKILL.md');
        // v0.1.2 wrote a flat file at ~/.claude/skills/mind-expander.md.
        // Claude Code only discovers skills in directory-per-skill
        // layout, so that file was dead weight — remove it.
        const v012Stale = path.join(home, '.claude', 'skills', 'mind-expander.md');
        const cleaned = tryUnlink(v012Stale);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, skill);
        return { dest, cleaned };
      },
    },
    {
      name: 'Codex',
      scope: 'user',
      detect: () => fs.existsSync(path.join(home, '.codex')),
      describe: () =>
        path.join(home, '.agents', 'skills', 'mind-expander', 'SKILL.md'),
      install: (skill) => {
        // Codex skills live under ~/.agents/skills/, per the agents-spec
        // both OpenAI and the broader ecosystem are converging on. The
        // ~/.codex/ directory holds Codex's own CLI state + AGENTS.md
        // for general instructions; neither is the skills directory.
        const dir = path.join(home, '.agents', 'skills', 'mind-expander');
        const dest = path.join(dir, 'SKILL.md');
        // v0.1.2 appended a marker-fenced block to ~/.codex/AGENTS.md.
        // That's the WRONG file for skills (it's general instructions,
        // not a skill) — strip the block out cleanly so a user who
        // upgraded doesn't keep our content polluting their AGENTS.md.
        const agentsPath = path.join(home, '.codex', 'AGENTS.md');
        let cleaned = false;
        if (fs.existsSync(agentsPath)) {
          const existing = fs.readFileSync(agentsPath, 'utf8');
          const START = '<!-- mind-expander:start -->';
          const END = '<!-- mind-expander:end -->';
          const s = existing.indexOf(START);
          const e = existing.indexOf(END);
          if (s !== -1 && e !== -1 && e > s) {
            const before = existing.slice(0, s).trimEnd();
            const after = existing.slice(e + END.length).trimStart();
            const stripped =
              (before + (before && after ? '\n\n' : '') + after).trimEnd() +
              '\n';
            if (stripped.trim() === '') {
              // We were the only thing in AGENTS.md. Remove the file
              // entirely rather than leaving an empty stub behind.
              fs.unlinkSync(agentsPath);
            } else {
              fs.writeFileSync(agentsPath, stripped);
            }
            cleaned = true;
          }
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, skill);
        return { dest, cleaned };
      },
    },
    {
      name: 'Cursor',
      scope: 'project',
      detect: () =>
        fs.existsSync(path.join(cwd, '.cursor')) ||
        fs.existsSync(path.join(cwd, '.cursorrules')),
      describe: () => path.join(cwd, '.cursor', 'rules', 'mind-expander.mdc'),
      install: (skill) => {
        const dir = path.join(cwd, '.cursor', 'rules');
        const dest = path.join(dir, 'mind-expander.mdc');
        // v0.1.2 used the .md extension. Cursor's documented format
        // requires .mdc to enable the activation-mode frontmatter
        // semantics — the .md file would have been silently ignored
        // outside the legacy `.cursorrules` non-Agent code path.
        const v012Stale = path.join(dir, 'mind-expander.md');
        const cleaned = tryUnlink(v012Stale);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, skill);
        return { dest, cleaned };
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
        `Looked for:\n` +
        `  • ~/.claude/  (Claude Code)\n` +
        `  • ~/.codex/   (Codex)\n` +
        `  • .cursor/    (Cursor, in current directory)\n\n` +
        `If you have an agent installed in a non-standard location, copy\n` +
        `the bundled skill file manually:\n\n` +
        `  Claude Code:  ${path.join('~/.claude/skills/mind-expander/SKILL.md')}\n` +
        `  Codex:        ${path.join('~/.agents/skills/mind-expander/SKILL.md')}\n` +
        `  Cursor:       ${path.join('<project>/.cursor/rules/mind-expander.mdc')}\n\n` +
        `Source: ${SKILL_SOURCE}\n`,
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
      const { dest, cleaned } = t.install(skill);
      process.stdout.write(`  ✓ wrote ${dest}\n`);
      if (cleaned) {
        process.stdout.write(
          `    (also cleaned up the broken v0.1.2 install)\n`,
        );
      }
      process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(`  ✗ failed: ${err.message}\n\n`);
    }
  }

  process.stdout.write(
    `Done. Re-run \`npx mind-expander install-skill\` after upgrading\n` +
      `the package to refresh the installed skill files.\n`,
  );
}

module.exports = main;
