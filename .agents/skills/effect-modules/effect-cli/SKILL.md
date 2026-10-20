---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: "Use when building a typed command-line program with Effect: parse flags and arguments, run command handlers, prompt interactively, or manage help and exit behavior."
metadata:
  github-path: skills/effect-cli
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 75d4480a2d508a42f733fc906c3c62339cbd22b7
name: effect-cli
---

# Effect CLI

Use `effect/cli` for command trees and typed flags. Keep parsing in
`Command` and `Flag`, domain operations in services, and process signals and
exit codes at the platform run boundary. Check the consuming project's
installed version: this entrypoint exists in v4, not v3.

## A command boundary

```ts
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

const port = Flag.Int("port").pipe(Flag.withDefault(8080));
const serve = Command.make("serve", { port }).pipe(
  Command.withHandler(({ port }) => Effect.logInfo(`listening on ${port}`)),
);

const cli = Command.run(serve, { version: "1.0.0" });
```

Supply terminal and runtime services at the outermost entrypoint; do not run
the command while defining it. Parse values before invoking a service, and
test argument errors separately from handler failures. A prompt needs an
explicit cancellation and non-TTY policy; never echo secrets.

## Adjacent responsibilities

Use Schema to validate complex input after parsing, Config for deployment
settings, and platform services for files and process lifecycle. Doctest
belongs with testing; OpenAPI generation belongs with a typed HTTP API, not
with CLI handlers.

## Sources

- [CLI API](https://effect.website/docs/v4/api/effect/cli/Command)
- [Pinned Command source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/cli/Command.ts)
