use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

const SKILL: &str = include_str!("../skill/mind-expander.md");

struct Agent {
    name: &'static str,
    scope: &'static str,
    dest: PathBuf,
}

pub fn run(yes: bool) -> anyhow::Result<()> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let cwd = std::env::current_dir()?;

    let mut agents: Vec<Agent> = Vec::new();

    if home.join(".claude").is_dir() {
        agents.push(Agent {
            name: "Claude Code",
            scope: "user",
            dest: home
                .join(".claude")
                .join("skills")
                .join("mind-expander")
                .join("SKILL.md"),
        });
    }
    if home.join(".codex").is_dir() {
        agents.push(Agent {
            name: "Codex",
            scope: "user",
            dest: home
                .join(".agents")
                .join("skills")
                .join("mind-expander")
                .join("SKILL.md"),
        });
    }
    if cwd.join(".cursor").is_dir() || cwd.join(".cursorrules").exists() {
        agents.push(Agent {
            name: "Cursor",
            scope: "project",
            dest: cwd.join(".cursor").join("rules").join("mind-expander.mdc"),
        });
    }

    if agents.is_empty() {
        println!("mind-expander install-skill\n");
        println!("No supported agents detected on this machine.");
        println!("Looked for:");
        println!("  \u{2022} ~/.claude/  (Claude Code)");
        println!("  \u{2022} ~/.codex/   (Codex)");
        println!("  \u{2022} .cursor/    (Cursor, in current directory)\n");
        println!("Copy the bundled skill file manually if needed:\n");
        println!("  Claude Code:  ~/.claude/skills/mind-expander/SKILL.md");
        println!("  Codex:        ~/.agents/skills/mind-expander/SKILL.md");
        println!("  Cursor:       <project>/.cursor/rules/mind-expander.mdc");
        return Ok(());
    }

    println!("mind-expander install-skill\n");
    println!(
        "Detected {} agent{}:",
        agents.len(),
        if agents.len() == 1 { "" } else { "s" }
    );
    for a in &agents {
        println!(
            "  \u{2022} {} ({}) \u{2192} {}",
            a.name,
            a.scope,
            a.dest.display()
        );
    }
    println!();

    for a in &agents {
        if !yes {
            print!("Install skill to {}? [Y/n] ", a.name);
            io::stdout().flush()?;
            let mut line = String::new();
            io::stdin().lock().read_line(&mut line)?;
            let ans = line.trim().to_lowercase();
            if !ans.is_empty() && ans != "y" && ans != "yes" {
                println!("  skipped\n");
                continue;
            }
        }

        let cleaned = cleanup_v012(a, &home, &cwd);

        if let Some(parent) = a.dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&a.dest, SKILL)?;
        println!("  \u{2713} wrote {}", a.dest.display());
        if cleaned {
            println!("    (also cleaned up the broken v0.1.2 install)");
        }
        println!();
    }

    println!("Done. Re-run `mind-expander install-skill` after upgrading");
    println!("the package to refresh the installed skill files.");
    Ok(())
}

fn cleanup_v012(agent: &Agent, home: &Path, cwd: &Path) -> bool {
    match agent.name {
        "Claude Code" => {
            let stale = home.join(".claude").join("skills").join("mind-expander.md");
            try_remove(&stale)
        }
        "Codex" => {
            let agents_md = home.join(".codex").join("AGENTS.md");
            cleanup_codex_agents_md(&agents_md)
        }
        "Cursor" => {
            let stale = cwd.join(".cursor").join("rules").join("mind-expander.md");
            try_remove(&stale)
        }
        _ => false,
    }
}

fn try_remove(path: &Path) -> bool {
    matches!(fs::remove_file(path), Ok(()))
}

fn cleanup_codex_agents_md(path: &Path) -> bool {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    const START: &str = "<!-- mind-expander:start -->";
    const END: &str = "<!-- mind-expander:end -->";
    let s = match content.find(START) {
        Some(i) => i,
        None => return false,
    };
    let e = match content.find(END) {
        Some(i) => i,
        None => return false,
    };
    if e <= s {
        return false;
    }
    let before = content[..s].trim_end();
    let after = content[e + END.len()..].trim_start();
    if before.is_empty() && after.is_empty() {
        let _ = fs::remove_file(path);
    } else {
        let stripped = match (before.is_empty(), after.is_empty()) {
            (true, _) => format!("{after}\n"),
            (_, true) => format!("{before}\n"),
            _ => format!("{before}\n\n{after}\n"),
        };
        let _ = fs::write(path, stripped);
    }
    true
}
