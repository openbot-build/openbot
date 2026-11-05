# Interactive input with a safe fallback

Prompts need a `Terminal`. Offer them only when the flag is missing, and keep a
non-interactive path for CI:

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { Command, Flag, Prompt } from "effect/cli"

const init = Command.make(
  "init",
  {
    // Passed on the command line -> no prompt. Missing -> ask.
    name: Flag.String("name").pipe(
      Flag.withFallbackPrompt(Prompt.String({ message: "Project name" }))
    ),
    private: Flag.Boolean("private").pipe(Flag.withDefault(false))
  },
  ({ name, private: isPrivate }) => Console.log(`creating ${name} (private=${isPrivate})`)
)

init.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

A fallback prompt only runs when `TerminalCapabilities.canPrompt` is true (stdin and
stdout are TTYs and `TERM` is not `dumb`); otherwise the command fails with the
ordinary missing-flag error, so CI never hangs.

Treat prompt cancellation (Ctrl-C, `Terminal.QuitError`) as an interrupt: the
runner already converts it. Never prompt for secrets with a visible prompt; use
`Prompt.Password` or `Prompt.Hidden`, or better, a `Flag.Redacted` with a
`Config.Redacted` fallback.
