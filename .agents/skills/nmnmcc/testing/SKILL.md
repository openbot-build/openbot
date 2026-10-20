---
description: Use when deciding what evidence can expose a credible software fault.
metadata:
  github-path: skills/testing
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/skills
  github-tree-sha: 0e925dece18fd636fb67edc0570ad1f49503e4ec
name: testing
---

# Testing

Treat a test as an experiment. Add or run one when a concrete unknown remains, a credible wrong behavior is possible, and the result would change the implementation or release decision.

1. State the required behavior and the wrong behavior still left open.
2. Choose the smallest boundary with an independent oracle.
3. Exercise the case, boundary, failure, or recovery that can distinguish them.
4. Read every result and report what remains untested.

Read [the detailed guide](references/guide.md) for test sensitivity, doubles, flaky signals, properties, or suite design. A justified "no new test" is a valid result when existing evidence is sufficient.
