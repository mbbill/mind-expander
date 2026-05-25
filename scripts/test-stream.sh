#!/usr/bin/env bash
#
# Test fixture: simulates mind-expander emitting one user question
# every 5 seconds. Used to validate whether an AI coding agent
# (Claude Code via Monitor, Codex via whatever) can react in real
# time to each new stdout line from a long-running background
# process.
#
# How to use:
#   1. Start a fresh agent session.
#   2. Ask the agent something like:
#        "Run scripts/test-stream.sh in the background and watch its
#         output. Every time a new JSON line appears, reply:
#         'got message: <id>: <text>'. Keep doing this until I stop you."
#   3. Observe whether the agent really echoes each new line within
#      a few seconds of it appearing, while you keep typing other
#      things at the agent in the same session.
#
# Kill cleanly with Ctrl+C (trap handles it).

set -e

trap 'echo "test-stream: stopped" >&2; exit 0' INT TERM

QUESTIONS=(
  "What does this function actually do?"
  "Is this thread-safe?"
  "Why is this marked unsafe?"
  "Where is this called from?"
  "How does the error propagate from here?"
  "What's the lifecycle of this struct?"
  "Why is the return type wrapped in Option?"
  "Is there a more idiomatic way to write this?"
)

echo "test-stream: starting, one JSON line every 5s (Ctrl+C to stop)" >&2

i=1
while true; do
  q="${QUESTIONS[$(( (i - 1) % ${#QUESTIONS[@]} ))]}"
  printf '{"type":"question","id":"q-%03d","text":"%s","ts":%d}\n' \
    "$i" "$q" "$(date +%s)"
  i=$((i + 1))
  sleep 5
done
