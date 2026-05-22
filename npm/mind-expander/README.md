# mind-expander

A human-AI collaboration tool for large codebases.

Pair-programming with an AI falls apart on large codebases — the AI
can't see what you see, you can't see what it's reasoning about.
mind-expander is the shared workspace that closes that gap. Today
it's a live, tourable diagram of any codebase; the goal is the full
surface for human-AI software engineering.

## Usage

```bash
# View any codebase
npx mind-expander view /path/to/repo

# View a diff
npx mind-expander view /path/to/repo --at main..HEAD
```

The binary self-daemonizes on Unix and prints a `pid` + `port` you
can use to drive tours from an AI agent.

## Skill integration

The npm package ships the AI-agent skill file at
`node_modules/mind-expander/skill/mind-expander.md`. Install it into
your AI agent's skill directory (Claude Code, Cursor, etc.) so the
agent can build tours for you automatically.

## Documentation

Full README, demo videos, and architecture docs at
**[github.com/mbbill/mind-expander](https://github.com/mbbill/mind-expander)**.

## License

Apache-2.0
