---
description: Use when one technical rule must stay coherent across related modules.
metadata:
  github-path: skills/line
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/skills
  github-tree-sha: ca1678eb470c3ff0bcc1eebb821cb5704b83d083
name: line
---

# Line

Use this view when several local changes share one domain rule, interface, migration, or contract. Keep the rule consistent across its owned modules and return one coherent domain result.

1. State the domain rule and the modules it governs.
2. Inspect each owned boundary and the checks that can expose drift.
3. Resolve local causes with `point` while keeping the shared rule fixed.
4. Validate the domain result and report cross-domain concerns upward.

Read [the detailed guide](references/guide.md) when a `plane` pass or coordinated cluster sets ownership and interfaces.
