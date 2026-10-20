---
description: Use when data, runtime values, types, contracts, and allowed operations must stay aligned.
metadata:
  github-path: skills/typesafe
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/skills
  github-tree-sha: 0293e231af2a289c0997276f3bca4616fb0c6fc0
name: typesafe
---

# TypeSafe

Keep a value's meaning intact from its source to its final use. Make invalid states hard to represent where practical, and match every claimed guarantee to a type, contract, or runtime check that actually supports it.

1. Trace the value across boundaries and transformations.
2. Identify the source of truth for its shape and meaning.
3. Use the project's native types, schemas, and validation at the narrowest boundary.
4. Check both accepted values and important rejected or missing values.

Read [the detailed guide](references/guide.md) for generic APIs, schema design, migrations, or type/runtime gaps.
