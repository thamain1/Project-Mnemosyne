#!/usr/bin/env python3
"""
H2 14-day package gate (PreToolUse on Bash) for the token-governance system.
See TOKEN-GOVERNANCE-SYSTEM.md §5 H2 / §13.2 package_14_day_rule, and ~/.claude/CLAUDE.md.

Intercepts package-install commands that add a NEW external package and returns an
"ask" decision, so the 14-day supply-chain rule can never be silently skipped: the user
must consciously approve after the publish-date is checked.

ALLOWS (silently, exit 0) the documented exceptions:
  - lockfile restores: `npm ci`, bare `npm install`/`npm i`, `pnpm install`, `yarn`/`yarn install`,
    `pip install -r <reqs>`, `pip install -e .`/local paths
  - @scoped packages (treated as internal/org per the rule)
  - commands with no newly-named external package

ASKS for: `npm/pnpm/yarn add|install <pkg>`, `pip/pip3 install <pkg>`, `gem install <pkg>`,
`cargo add <pkg>` where <pkg> is a new external named package.

Does NOT itself fetch publish dates (kept lean per the over-engineering caution); the ask
reason reminds the operator to check the registry date and flag anything < 14 days old.
Fails OPEN on any internal error (Layer-1 feedback, not the canonical gate).
"""

import sys
import re
import json
import shlex

# install verbs that ADD packages (vs. restore)
ADD_VERBS = {
    "npm": {"install", "i", "add"},
    "pnpm": {"add", "install", "i"},
    "yarn": {"add"},
    "pip": {"install"},
    "pip3": {"install"},
    "gem": {"install"},
    "cargo": {"add"},
}
# managers where a bare `install` with no package = lockfile restore (exempt)
RESTORE_IF_NO_PKG = {"npm", "pnpm", "yarn"}


def split_commands(command: str):
    """Split a compound shell command on && || ; | into segments."""
    return re.split(r"&&|\|\||;|\|", command)


def named_packages(tokens):
    """Given tokens after the verb, return external named packages (skip flags,
    flag-values, @scoped, requirement files, local paths)."""
    pkgs = []
    skip_next = False
    for i, t in enumerate(tokens):
        if skip_next:
            skip_next = False
            continue
        if t in ("-r", "--requirement", "-c", "--constraint"):
            skip_next = True            # consumes a requirements/constraints file -> restore
            return []                   # treat whole install as a restore: exempt
        if t.startswith("-"):
            continue                    # other flags (-g, -D, --save-dev, etc.)
        if t.startswith("@"):
            continue                    # @scoped -> exempt per rule
        if t in (".", "..") or "/" in t or t.startswith("./") or t.endswith(".txt"):
            continue                    # local path / editable / file -> exempt
        pkgs.append(t)
    return pkgs


def scan(command: str):
    """Return list of new external packages that should trigger an ask, or []."""
    for seg in split_commands(command):
        try:
            toks = shlex.split(seg.strip(), posix=True)
        except ValueError:
            toks = seg.split()
        if not toks:
            continue
        # find the manager token (allow a leading `sudo`)
        idx = 1 if toks[0] == "sudo" and len(toks) > 1 else 0
        mgr = toks[idx]
        if mgr not in ADD_VERBS:
            continue
        rest = toks[idx + 1:]
        if not rest:
            continue
        verb = rest[0]
        if verb == "ci":                 # npm ci -> restore
            continue
        if verb not in ADD_VERBS[mgr]:
            continue
        after = rest[1:]
        pkgs = named_packages(after)
        if not pkgs and mgr in RESTORE_IF_NO_PKG:
            continue                     # bare install -> restore, exempt
        if pkgs:
            return pkgs
    return []


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    command = (data.get("tool_input") or {}).get("command", "") or ""
    pkgs = scan(command)
    if not pkgs:
        sys.exit(0)

    reason = (
        "H2 14-day package rule: about to install new external package(s): "
        + ", ".join(pkgs) + ".\n\n"
        "Before approving, check the target version's registry publish date. If it was "
        "published < 14 days ago, STOP and get explicit go-ahead (poisoned-package window).\n"
        "Exempt (approve freely): a version the user explicitly asked for, an internal/@scoped "
        "package, or a security patch for an active CVE.\n"
        "[Layer-1 reminder — see ~/.claude/CLAUDE.md + TOKEN-GOVERNANCE-SYSTEM.md §13.2]"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
