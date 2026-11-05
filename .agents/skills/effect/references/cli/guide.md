# Effect CLI

## How to think about it

A CLI is three separate things that scripts usually fuse: **parsing** untrusted
strings into typed input, **doing the work**, and **reporting** the outcome as
text plus an exit code. `effect/cli` makes the first and third declarative and
leaves the second to ordinary Effect services.

- A `Command` is a *value*: a name, a typed config built from `Flag`s (named
  options) and `Argument`s (positionals), and a handler `(config) => Effect`.
  The parsed config is typed from the declarations, so
  `Flag.Int("port").pipe(Flag.withDefault(8080))` gives `number` in the handler,
  `Flag.optional` gives `Option<A>`, `Argument.variadic` gives
  `ReadonlyArray<A>`. Parsing, `--help`, `--version`, `--completions`, `--wizard`,
  `--log-level` and usage errors with suggestions come with `Command.run`.
- Subcommands form a tree. A parent can declare **shared flags** that every
  descendant reads with `yield* parentCommand`.
- Everything the handler needs from outside (filesystem, terminal, child
  processes, your own services) arrives through `R`. `Command.run` needs
  `Command.Environment` (FileSystem, Path, Terminal, Stdio, ChildProcessSpawner),
  which `NodeServices.layer` provides. Your domain services are provided with
  `Command.provide`.

Coming from commander/yargs/argparse people get these wrong: they parse into a
loose bag and validate later (do it in the declaration: `Flag.withSchema`,
`Argument.withSchema`, `Flag.Literals`), they call `process.exit` in handlers
(fail with a typed error and let the runtime set the exit code), they read
`process.env` inside handlers (use `Flag.withFallbackConfig`), and they
`console.log` from business code (put output behind a service or `Console`, so
tests can capture it).

## Choose

| Situation | API | Why |
| --- | --- | --- |
| Named option with a type | `Flag.String/Int/Finite/Boolean/Date/Path/File/Directory` | parsed and typed per flag; Boolean also accepts `--no-x` |
| Option from a fixed set | `Flag.Literals("level", ["low", "high"])` | handler gets the literal union |
| Positional input | `Argument.String/Int/File/...`, `Argument.variadic()`, `Argument.optional` | positional order is part of the contract |
| Default / optional | `Flag.withDefault(v)`, `Flag.optional` (gives `Option`) | the type reflects it |
| Validate beyond the primitive | `Flag.withSchema(schema)`, `Argument.withSchema(schema)` | reject at parse time; handler sees only valid data ([schema](../schema/guide.md)) |
| Value from env var | `Flag.withFallbackConfig(Config.string("X"))` | flag > env > default, typed, redacted if `Config.Redacted` |
| Ask only when missing and interactive | `Flag.withFallbackPrompt(Prompt.String({ message }))` | never blocks scripts that pass the flag |
| Secret input | `Flag.Redacted("token")` | `Redacted<string>`; never echoed or logged |
| Options shared by all subcommands | `Command.withSharedFlags({...})` + `yield* parent` | accepted before or after the subcommand name |
| Options affecting the whole program | `Command.withGlobalFlags([...])`, `GlobalFlag.Setting(...)` | built-ins: `--help`, `--version`, `--completions`, `--wizard`, `--log-level` |
| Services for handlers | `Command.provide(layer \| (input) => layer)` | R is satisfied per command, or chosen from flags |
| Friendly failure | `new CliError.UserError({ cause, userMessage })`, or a `[CliError.userMessage]` getter on your own tagged error | rendered to stderr without a stack trace; the getter keeps the error's tag |
| Rules across several flags | `Command.validate(({ a, b }) => ...)` | fails with usage before the handler; use `CliError.ValidationError` |
| Flag that works bare or with a value | `Flag.withOptionalValue("x")` | `--watch` or `--watch=until-done` |
| Interactive form | `Prompt.String/Confirm/Select/Password/...` then `Prompt.run` | needs `Terminal`; give a non-interactive path as well |
| NOT for: a long-running server | `Layer.launch(...)` + `NodeRuntime.runMain` | a CLI that only starts a server needs a flag set, not a command tree |
| NOT for: structured config files | `Config` / [config](../config/guide.md) | flags override config, they do not replace it |

## Recipe

### A task manager with subcommands, typed errors and a service

Design decisions are in the comments. Domain logic lives in a service with a
typed error; handlers translate that error into a user-facing one; flags carry
the validation.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"

// --- Domain: knows nothing about argv, exit codes or stdout --------------

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", {
  id: Schema.Int
}) {}

export type Priority = "low" | "normal" | "high"
export interface Task {
  readonly id: number
  readonly title: string
  readonly priority: Priority
  readonly done: boolean
}

export class Tasks extends Context.Service<Tasks, {
  add(title: string, priority: Priority): Effect.Effect<Task>
  complete(id: number): Effect.Effect<Task, TaskNotFound>
  list(status: "open" | "done" | "all"): Effect.Effect<ReadonlyArray<Task>>
}>()("app/Tasks") {
  // The in-memory implementation doubles as the test layer. A production CLI
  // would add layerFile / layerHttp with the same shape.
  static readonly layerMemory = Layer.effect(
    Tasks,
    Effect.gen(function*() {
      const store = yield* Ref.make<ReadonlyArray<Task>>([])
      return Tasks.of({
        add: (title, priority) =>
          Ref.modify(store, (all) => {
            const task: Task = { id: all.length + 1, title, priority, done: false }
            return [task, [...all, task]]
          }),
        complete: (id) =>
          Ref.get(store).pipe(
            Effect.flatMap((all) => {
              const found = all.find((task) => task.id === id)
              return found === undefined
                ? Effect.fail(new TaskNotFound({ id }))
                : Ref.set(store, all.map((task) => task.id === id ? { ...task, done: true } : task)).pipe(
                  Effect.as({ ...found, done: true })
                )
            })
          ),
        list: (status) =>
          Ref.get(store).pipe(
            Effect.map((all) =>
              status === "all" ? all : all.filter((task) => task.done === (status === "done"))
            )
          )
      })
    })
  )
}

// --- Commands: parse, call the service, print ----------------------------

// The root only declares what every subcommand shares.
const tasks = Command.make("tasks").pipe(
  Command.withDescription("Track tasks"),
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print machine-readable output"),
      Flag.withDefault(false)
    )
  })
)

// Output in one place: humans get lines, scripts get JSON.
const print = (json: boolean, value: unknown, text: string) =>
  Console.log(json ? JSON.stringify(value) : text)

const add = Command.make(
  "add",
  {
    // Validation is part of the declaration: an empty title never reaches the handler.
    title: Argument.String("title").pipe(Argument.withSchema(Schema.NonEmptyString)),
    priority: Flag.Literals("priority", ["low", "normal", "high"]).pipe(Flag.withDefault("normal"))
  },
  Effect.fn("tasks.add")(function*({ title, priority }) {
    const { json } = yield* tasks // shared flag from the parent
    const task = yield* (yield* Tasks).add(title, priority)
    yield* print(json, task, `added #${task.id} ${task.title} (${task.priority})`)
  })
).pipe(Command.withDescription("Add a task"))

const done = Command.make(
  "done",
  { id: Argument.Int("id") },
  Effect.fn("tasks.done")(function*({ id }) {
    const { json } = yield* tasks
    const task = yield* (yield* Tasks).complete(id).pipe(
      // Domain failure -> message for a person. UserError is rendered to stderr
      // without a stack trace, and the process still exits non-zero.
      Effect.catchTag("TaskNotFound", (e) =>
        Effect.fail(new CliError.UserError({ cause: e, userMessage: `No task with id ${e.id}` })))
    )
    yield* print(json, task, `completed #${task.id}`)
  })
).pipe(Command.withDescription("Mark a task as done"), Command.withAlias("complete"))

const list = Command.make(
  "list",
  { status: Flag.Literals("status", ["open", "done", "all"]).pipe(Flag.withDefault("open")) },
  Effect.fn("tasks.list")(function*({ status }) {
    const { json } = yield* tasks
    const items = yield* (yield* Tasks).list(status)
    yield* print(json, items, items.map((task) => `#${task.id} ${task.title}`).join("\n") || "no tasks")
  })
).pipe(Command.withDescription("List tasks"), Command.withAlias("ls"))

const login = Command.make(
  "login",
  {
    // flag > TASKS_TOKEN env > failure. Redacted: printing it shows <redacted>.
    token: Flag.Redacted("token").pipe(Flag.withFallbackConfig(Config.Redacted("TASKS_TOKEN")))
  },
  Effect.fn("tasks.login")(function*({ token }) {
    yield* Console.log(`token has ${Redacted.value(token).length} characters`)
  })
).pipe(Command.withDescription("Store credentials"))

// --- Assembly: one tree, one provide, one run ------------------------------

export const cli = tasks.pipe(
  Command.withSubcommands([add, done, list, login]),
  // Services for all handlers are chosen here, once. Swap for a test layer.
  Command.provide(Tasks.layerMemory)
)

// Command.run reads argv from Stdio; NodeServices supplies the Environment.
cli.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

What the types tell you: every handler is `Effect<void, TaskNotFound | CliError.UserError, Tasks>`
before `Command.provide`; after it `Tasks` is gone. The parse layer adds
`CliError.CliError` (bad flags, `ShowHelp`) to the error of the run effect.
`runMain` turns a failure into a non-zero exit code; that is the *only* exit
mechanism you need.

For interactive input (`Flag.withFallbackPrompt`, prompt cancellation, secrets) see [references/prompts.md](prompts.md): offer a prompt only when the flag is missing, and keep a non-interactive path for CI.

## Anti-patterns

**`process.exit` in a handler.** It exits the process immediately, so scoped
resources and finalizers in flight do not get to run, and the handler cannot be
tested in-process.

```ts skip
Effect.sync(() => { console.error("bad"); process.exit(2) })
```

Fail with a typed error (`CliError.UserError` for messages) and let
`NodeRuntime.runMain` set the code.

**Parsing everything as strings then validating inside the handler.** Errors
show up late, with no usage text.

```ts skip
Flag.String("port") // then Number(port) in the handler
```

Use `Flag.Int("port").pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))))`
or `Flag.Literals`; bad input is rejected with help output.

**Reading `process.env` or `process.argv` directly.** Not overridable in tests
and invisible in `--help`.

```ts skip
const token = process.env.TASKS_TOKEN!
```

Use `Flag.Redacted("token").pipe(Flag.withFallbackConfig(Config.Redacted("TASKS_TOKEN")))`.

**Printing secrets or whole config objects.** Logs and CI output are
long-lived.

```ts skip
yield* Console.log(`using token ${token}`)
```

Keep secrets as `Redacted` all the way (`Flag.Redacted`, `Argument.Redacted`);
`String(token)` is `<redacted>`.

**Using `Effect.runPromise` inside a handler.** You leave
the runtime: no interruption, no Layer context, no exit code.

```ts skip
async ({ id }) => { await Effect.runPromise(Tasks.use((t) => t.complete(id))) } // also: Tasks is missing from R
```

Handlers return Effects; compose with `yield*`.

**Not providing the environment.** `Command.run(...)` has
`R = Command.Environment | ...` and does nothing until you provide it.

```ts skip
cli.pipe(Command.run({ version: "1" }), NodeRuntime.runMain) // type error: services missing
```

Add `Effect.provide(NodeServices.layer)` before `runMain`.

**Duplicating flags on every subcommand.** Copies drift and `--help` becomes
inconsistent.

```ts skip
const a = Command.make("a", { json: Flag.Boolean("json") })
const b = Command.make("b", { json: Flag.Boolean("json") })
```

Declare them once with `Command.withSharedFlags` on the parent and read them
with `yield* parent`.

**Interactive-only input.** A prompt with no flag makes the command unusable
in scripts and CI.

```ts skip
const name = yield* Prompt.run(Prompt.String({ message: "Name" }))
```

Use `Flag.withFallbackPrompt` so passing the flag skips the prompt.

## Testing it

Run the command tree in-process with `Command.runWith(cmd, { version })(argv)`,
a fake environment, and in-memory services. No process, no TTY. This test
adapts the pattern from the library's own docs: only the services `Command.Environment`
names are stubbed (`FileSystem`, `Path`, `Stdio`, `Terminal`, `ChildProcessSpawner`),
and `TestConsole` captures what the handler prints.

```ts import.meta.vitest name="references/cli/guide.md#10"
import assert from "node:assert/strict"
import { Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { ChildProcessSpawner } from "effect/process"
import { TestConsole } from "effect/testing"

const add = Command.make(
  "add",
  { title: Argument.String("title"), count: Flag.Int("count").pipe(Flag.withDefault(1)) },
  ({ title, count }) => Console.log(`added ${count} x ${title}`)
)
const cli = Command.make("tasks").pipe(Command.withSubcommands([add]))

// Everything Command.run requires, stubbed. Reuse this layer across tests.
const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void
    })
  ),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("unused"))),
  TestConsole.layer
)

const run = (...argv: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(argv)

const program = Effect.gen(function*() {
  // Success: parsed values reach the handler typed.
  yield* run("add", "milk", "--count", "2")
  assert.deepEqual(yield* TestConsole.logLines, ["added 2 x milk"])

  // Parse failure: a typed CliError, not an exception or a process exit.
  const exit = yield* Effect.exit(run("add", "milk", "--count", "two"))
  assert.equal(exit._tag, "Failure")
  const failure = yield* Effect.flip(run("add", "milk", "--count", "two"))
  assert.ok(CliError.isCliError(failure))
}).pipe(Effect.provide(CliTestLayer))

await Effect.runPromise(program)
```

### 4.1 additions in one tested command

`Flag.withOptionalValue` (GNU `--color[=WHEN]` style), `Flag.withNegation`,
`Command.validate` (cross-flag rules that fail with usage), and
`TerminalCapabilities` (prompts are skipped on non-TTY stdin/stdout, so a
missing flag fails instead of hanging in CI) all run in-process:

```ts import.meta.vitest name="references/cli/guide.md#11"
import assert from "node:assert/strict"
import { Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { CliError, Command, Flag, Prompt, TerminalCapabilities } from "effect/cli"
import { ChildProcessSpawner } from "effect/process"
import { TestConsole } from "effect/testing"

const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void
    })
  ),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("unused"))),
  TestConsole.layer
)

const deploy = Command.make(
  "deploy",
  {
    // `--watch` alone means "first-failure"; a value must be attached: --watch=until-done
    watch: Flag.Literals("watch", ["first-failure", "until-done"]).pipe(
      Flag.withOptionalValue("first-failure"),
      Flag.optional
    ),
    // `--skip-validate` replaces the default `--no-validate`
    validate: Flag.Boolean("validate").pipe(Flag.withDefault(true), Flag.withNegation("skip-validate")),
    api: Flag.Boolean("api").pipe(Flag.withDefault(false)),
    docker: Flag.Boolean("docker").pipe(Flag.withDefault(false))
  },
  ({ watch, validate }) => Console.log(`watch=${watch._tag === "Some" ? watch.value : "off"} validate=${validate}`)
).pipe(
  Command.validate(({ api, docker }) =>
    api && docker
      ? Effect.fail(new CliError.ValidationError({ message: "--api and --docker are mutually exclusive" }))
      : Effect.void
  )
)

const run = (...argv: ReadonlyArray<string>) => Command.runWith(deploy, { version: "1.0.0" })(argv)

// Asks only when interactive; canPrompt=false keeps CI from blocking on a prompt.
const init = Command.make(
  "init",
  { name: Flag.String("name").pipe(Flag.withFallbackPrompt(Prompt.String({ message: "Name" }))) },
  ({ name }) => Console.log(`init ${name}`)
)

const program = Effect.gen(function*() {
  yield* run("--watch", "--skip-validate")
  yield* run("--watch=until-done")
  assert.deepEqual(yield* TestConsole.logLines, ["watch=first-failure validate=false", "watch=until-done validate=true"])

  // Validation failures are shown with usage (ShowHelp) and the handler never runs.
  const invalid = yield* Effect.flip(run("--api", "--docker"))
  assert.equal(invalid._tag, "ShowHelp")
  assert.equal(invalid.errors[0]?.message, "--api and --docker are mutually exclusive")

  // The default negation was replaced.
  const rejected = yield* Effect.flip(run("--no-validate"))
  assert.equal(rejected._tag, "ShowHelp")

  // Non-interactive terminal: no prompt, the original MissingOption error comes back.
  const missing = yield* Effect.flip(
    Command.runWith(init, { version: "1.0.0" })([]).pipe(
      Effect.provideService(TerminalCapabilities.TerminalCapabilities, {
        canColor: false,
        canAnimate: false,
        canPrompt: false
      })
    )
  )
  assert.equal(missing._tag, "ShowHelp")
  assert.deepEqual(missing.errors.map((error) => error._tag), ["MissingOption"])
}).pipe(Effect.provide(CliTestLayer))

await Effect.runPromise(program)
```

For handlers with services, `Command.provide(Tasks.layerMemory)` (as in the
recipe) already installs the double; to inspect state, expose the service in the
test and call it after `run(...)`. For prompts, give `Terminal.make` a
`readInput` that returns a `Queue` of scripted `UserInput` events (`Effect<Queue.Dequeue<UserInput>, never, Scope>`). With `@effect/vitest` the same body runs
under `it.effect`; see [testing](../testing/guide.md).

## Changed in 4.1

Verified against `effect@4.1.2` sources (diffed with 4.0.0).

- New combinators: `Flag.withOptionalValue`, `Flag.withNegation`,
  `Flag.withoutNegation` (and `Param` equivalents), `Command.validate`.
- `CliError.ValidationError`, the `CliError.userMessage` key and
  `CliError.getUserMessage`: handler errors can describe themselves to the user
  without being wrapped in `UserError`.
- `CliOutput.Presenter` (`layerPresenter`, `defaultPresenter`) routes built-in
  help/version/invalid-invocation output; implicit help still fails with `ShowHelp`.
- `TerminalCapabilities` module: `withFallbackPrompt` is skipped when
  `canPrompt` is false (non-TTY, `TERM=dumb`), returning the missing-option
  error instead of hanging. Help color follows `canColor`.
- `--completions` also accepts `powershell` (alias `pwsh`); new
  `Completions.fromCommand` builds a descriptor for build-time generation.
- `Terminal.Terminal` gained `size` (a scoped queue of resize events), so
  hand-built test terminals must provide `size` as well as `columns`/`rows`.
- `Prompt.Theme` has a `colors` flag (auto-detected from TTY and `NO_COLOR`);
  provide a theme with `colors: false` to disable prompt and wizard styling.

## Boundaries

- Rich input validation and codecs (`withSchema`): [schema](../schema/guide.md).
- Env/files/default values, `Config.Redacted`: [config](../config/guide.md).
- Filesystem, path, terminal, child processes and the `NodeServices` layer:
  [platform](../platform/guide.md).
- Service/layer design for the logic behind handlers: [services](../services/guide.md).
- Logging flags (`--log-level`) feed `References.MinimumLogLevel`; log
  routing, spans and exporters: [observability](../observability/guide.md).
- HTTP endpoints or OpenAPI belong in [http-api](../http-api/guide.md), not in command
  handlers. Test strategy and `it.effect`: [testing](../testing/guide.md).

Errors cross this boundary as `CliError.CliError` (parse/help/`UserError`) plus
whatever `E` your handlers declare; resources (files, subprocesses) belong in
handler-scoped `Effect.scoped` or provided layers, not in module scope.

## References

- [references/api-cheatsheet.md](api-cheatsheet.md) - verified combinator list and run-time behaviour
- [references/prompts.md](prompts.md) - interactive input with a safe fallback
- [Command API](https://effect.website/docs/v4/api/effect/cli/Command)
- [Flag API](https://effect.website/docs/v4/api/effect/cli/Flag)
- [Argument API](https://effect.website/docs/v4/api/effect/cli/Argument)
- [Prompt API](https://effect.website/docs/v4/api/effect/cli/Prompt)
- [Command source at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/cli/Command.ts)
- [Upstream example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/70_cli/10_basics.ts)
