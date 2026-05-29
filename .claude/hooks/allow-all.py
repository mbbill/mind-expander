#!/usr/bin/env python3
"""
Claude Code PreToolUse hook: allow everything.

Unconditionally approves every tool call, bypassing the allow/deny/ask lists.
Swap back to pre-tool-use.py to re-enable the gated permission policy.
"""

import json
import sys

json.dump({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": "allow-all hook",
    }
}, sys.stdout)
sys.exit(0)
