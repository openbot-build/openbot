---
description: Use for work with two or more independently owned workstreams that need coordinated integration.
metadata:
  github-path: skills/cluster
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/skills
  github-tree-sha: 97e6d28c52bc7bfcf59564c9efd9c8f8666af82f
name: cluster
---

# Cluster

Use this skill only when parallel ownership will produce independent, reviewable progress. The root owner keeps the promised result; each contributor owns a bounded workstream and returns evidence for integration.

1. Define the result, boundaries, owners, shared interfaces, and acceptance checks.
2. Dispatch independent work with enough context to proceed without sibling internals.
3. Integrate returned changes through one validation pass.
4. Repair failures at the owning boundary, then re-run the affected checks.

Use [the detailed guide](references/guide.md) when the work needs the Plane, Line, and Point responsibility model. Keep a single local workflow when parallel work adds coordination without information.
