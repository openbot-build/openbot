# CLI API cheat sheet (effect@4.1.x)

Everything is imported from `effect/cli` (`Argument`, `CliError`, `CliOutput`,
`Command`, `Completions`, `Flag`, `GlobalFlag`, `HelpDoc`, `Param`, `Primitive`,
`Prompt`). The package is `@stability unstable`: pin `effect` exactly. Names
were checked against `node_modules/effect/src/cli`.

## Constructors

| Flag | Argument | Parsed type |
| --- | --- | --- |
| `Flag.String(name)` | `Argument.String(name)` | `string` |
| `Flag.Int(name)` / `Flag.Finite(name)` | `Argument.Int` / `Argument.Finite` | `number` |
| `Flag.Boolean(name)` | - | `boolean` (`--x` / `--no-x`; rename with `withNegation("skip-x")`, drop with `withoutNegation`) |
| `Flag.Date(name)` | `Argument.Date` | `Date` |
| `Flag.Literals(name, [...])` | `Argument.Literals(name, [...])` | literal union |
| `Flag.ChoiceWithValue(name, [[label, value], ...])` | `Argument.ChoiceWithValue` | the mapped value |
| `Flag.Path(name, opts)`, `File`, `Directory` | same names | `string` path, with existence/type checks via options |
| `Flag.FileText(name)` | `Argument.FileText` | contents of the named file |
| `Flag.FileParse`, `FileSchema(schema)` | same | parse/decode a file's contents |
| `Flag.Redacted(name)` | `Argument.Redacted` | `Redacted<string>` |
| `Flag.KeyValuePair(name)` | - | `Record<string, string>` (`--env A=1 --env B=2`) |

## Combinators (all dual: data-last in `pipe`, or data-first)

| Combinator | Effect on type |
| --- | --- |
| `withAlias("p")` (flag), `withDescription`, `withMetavar`, `withHidden` | help only |
| `withDefault(v)` | `A \| B` (never missing) |
| `optional` | `Option<A>` |
| `withFallbackConfig(Config)` | missing -> read from Config |
| `withFallbackPrompt(Prompt)` | missing -> ask interactively |
| `withSchema(schema)` | decode the parsed value; failure becomes a parse error with usage |
| `map`, `mapEffect`, `mapTryCatch`, `filter`, `filterMap` | transform or validate after parsing |
| `atLeast(n)`, `atMost(n)`, `between(a, b)`, `Argument.variadic(opts?)` | repetition -> `ReadonlyArray<A>` |
| `orElse`, `orElseResult` | alternative parser |
| `Flag.withOptionalValue(v)` | `--watch` alone means `v`; explicit values need `=` (`--watch=x`); it never eats the next token |
| `Flag.withNegation(name)` / `Flag.withoutNegation` | boolean flags only: rename or remove the `--no-<flag>` form |

```ts import.meta.vitest name="references/cli/api-cheatsheet.md#1"
import { Config, Schema } from "effect"
import { Argument, Flag, Prompt } from "effect/cli"

// Typed, range-checked at parse time. A bad value prints usage, not a stack trace.
export const port = Flag.Int("port").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Port to listen on"),
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  Flag.withDefault(8080)
)

// Resolution order: command line, then ENV, then (if still missing) the prompt.
export const region = Flag.String("region").pipe(
  Flag.withFallbackConfig(Config.String("APP_REGION")),
  Flag.withFallbackPrompt(Prompt.String({ message: "Region" }))
)

// Repeated positional values.
export const files = Argument.String("file").pipe(Argument.variadic())

// Repeated flag: --tag a --tag b
export const tags = Flag.String("tag").pipe(Flag.atLeast(0))
```

## Commands

| API | Use |
| --- | --- |
| `Command.make(name)` | no input, group node |
| `Command.make(name, config, handler?)` | `config` is a record (nesting allowed) of flags/arguments; handler receives the typed config |
| `Command.withHandler(f)` | add or replace the handler later |
| `Command.withSubcommands([a, b])` | build the tree |
| `Command.withSharedFlags({...})` | flags inherited by descendants; read with `yield* parent` |
| `Command.withGlobalFlags([GlobalFlag...])` | scope extra global flags |
| `Command.withDescription`, `withShortDescription`, `withAlias`, `withExamples([{ command, description }])`, `unlisted` | help and discoverability |
| `Command.provide(layer \| (input) => layer, { local? })`, `provideSync`, `provideEffect`, `provideEffectDiscard` | satisfy `R` of the handler; the layer may be built from parsed input |
| `Command.validate((input) => Effect<void, CliError>)` | cross-flag rules after parsing (mutually exclusive flags); failure shows usage, handler is skipped. Add it after `withSharedFlags`/`withSubcommands` to see those inputs |
| `Command.run({ version, renderErrors? })` | uses argv from `Stdio`; returns `Effect<void, E \| CliError, R \| Command.Environment>` |
| `Command.runWith(cmd, { version })(argv)` | explicit argv, for tests and embedding |
| `Command.wizard(cmd, ...)` | interactive builder (also `--wizard`) |

`Command.Environment` is `FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`.
`NodeServices.layer` from `@effect/platform-node` provides all of it.

```ts import.meta.vitest name="references/cli/api-cheatsheet.md#2"
import { Console, Context, Effect, Layer } from "effect"
import { Command, Flag } from "effect/cli"

class Greeter extends Context.Service<Greeter, { greet(name: string): string }>()("app/Greeter") {
  static readonly layer = (loud: boolean) =>
    Layer.succeed(Greeter, Greeter.of({ greet: (name) => (loud ? `HELLO ${name}` : `hello ${name}`) }))
}

// The layer is chosen from the parsed flags, so R disappears from the command.
export const hello = Command.make(
  "hello",
  { name: Flag.String("name"), loud: Flag.Boolean("loud").pipe(Flag.withDefault(false)) },
  Effect.fn(function*({ name }) {
    const greeter = yield* Greeter
    yield* Console.log(greeter.greet(name))
  })
).pipe(Command.provide(({ loud }) => Greeter.layer(loud)))
```

## Global flags

Built in: `--help/-h`, `--version/-v`, `--wizard`, `--completions <bash|zsh|fish|powershell|sh|pwsh>`,
`--log-level <level>` (sets `References.MinimumLogLevel` for the handler).
Custom: `GlobalFlag.Action({ flag, run })` performs a side effect and exits;
`GlobalFlag.Setting("id")({ flag })` returns a service whose value you read in the
handler, then attach with `Command.withGlobalFlags([...])`.

## Errors and exit behaviour

- Parse problems are `CliError` variants (`UnrecognizedOption`, `MissingOption`,
  `MissingArgument`, `InvalidValue`, `UnknownSubcommand`, `UnexpectedArgument`,
  `DuplicateOption`) wrapped into `ShowHelp`: help plus the error list are
  printed (to stdout/stderr via `CliOutput.Formatter`) and the run effect fails.
- `CliError.UserError({ cause, userMessage? })` is the supported way to fail a
  handler with a message for people. It is rendered to stderr and marked as
  reported so the runtime does not log it again.
- A handler error that carries a string `[CliError.userMessage]` (declare a getter on
  your tagged error) is rendered the same way **without wrapping**, so its tag
  survives for `catchTag` and tests; `CliError.getUserMessage(e)` reads it.
- Any other handler error is your `E`. `NodeRuntime.runMain` reports it and
  exits with a non-zero code. `renderErrors: false` leaves rendering to you.
- `Terminal.QuitError` (user pressed Ctrl-C in a prompt) becomes an interrupt.

## Output, terminal detection and completions (4.1)

- `CliOutput.Presenter` decides where built-in help, version and
  invalid-invocation output goes (`CliOutput.layerPresenter({ present })`,
  default `CliOutput.defaultPresenter`); events are `Help | InvalidInvocation | Version`
  and carry the `HelpDoc`/errors so you can still use `CliOutput.Formatter`.
  Completions scripts, wizard output and `userMessage` errors bypass it.
- `TerminalCapabilities.TerminalCapabilities` is a `Reference<{ canColor, canAnimate, canPrompt }>`
  detected from `NO_COLOR`, `FORCE_COLOR`, `TERM` and TTY state; `TerminalCapabilities.layer`
  detects through `ConfigProvider` and `Stdio`. `withFallbackPrompt` is skipped (original
  missing-option error) when `canPrompt` is `false`.
- `Completions.fromCommand(cmd)` + `Completions.generate(name, shell, descriptor)`
  build `bash | zsh | fish | powershell` scripts without running the CLI.

```ts import.meta.vitest name="references/cli/api-cheatsheet.md#3"
import { Effect } from "effect"
import { Command, Completions, Flag } from "effect/cli"

const start = Command.make("start", { port: Flag.Int("port") }, ({ port }) => Effect.log(`port ${port}`))
const cli = Command.make("server").pipe(Command.withSubcommands([start]))

const script = Completions.generate("server", "powershell", Completions.fromCommand(cli))
script.includes("server") // => true
```

## Prompts

`Prompt.String`, `Password`, `Hidden`, `Int`, `Number`, `Confirm`, `Toggle`,
`Select`, `MultiSelect`, `AutoComplete`, `Date`, `File`, `List`; compose with
`Prompt.all`, `Prompt.map`, `Prompt.flatMap`; run with `Prompt.run(prompt)`
(requires `FileSystem | Path | Terminal`; fails with `Terminal.QuitError`).
