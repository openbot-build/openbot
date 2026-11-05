# Platform: files, processes, and the process itself

## How to think about it

A platform is "everything that differs between Node, Bun, Deno and a browser":
the file system, paths, stdin/stdout, spawning processes, sockets, workers, how
signals shut the program down. Effect splits it in two so domain code never
learns which runtime it is on:

- **Interfaces live in the core `effect` package** as services:
  `FileSystem.FileSystem`, `Path.Path`, `Stdio.Stdio`, `Terminal.Terminal`,
  `ChildProcessSpawner.ChildProcessSpawner`, plus the `Socket` and `Worker`
  abstractions. They are ordinary `Context.Service`s: you `yield*` them and they
  show up in `R`. (Hashing, HMAC and secure randomness moved to the separate
  `effect/crypto` services in 4.1; see [encoding](../encoding/guide.md).)
- **Implementations live in `@effect/platform-<runtime>`** and arrive as
  Layers. In Node, `NodeServices.layer` provides all five core services at once
  (`ChildProcessSpawner | FileSystem | Path | Stdio | Terminal`),
  and `NodeRuntime.runMain` runs the program with signal handling.

So the rule is: **import interfaces from `effect`; import the adapter only in
the entry file.** A function that reads a file has type
`Effect<string, PlatformError, FileSystem>`, not "an async function that happens
to call `node:fs`". That gives you: a typed error channel (`PlatformError`),
interruption (a file read or a spawned child is cancelled with its fiber),
scoped cleanup (handles and processes close with their `Scope`), and a test
double you can swap in without touching `node:fs`.

Coming from Node: `fs.promises.readFile` rejects with an `Error` whose `code`
you must remember to check; `process.on("SIGINT")` handlers are yours to write
and order; `child_process.spawn` leaks the child if you forget `kill`. Here the
error is data (`error.reason._tag === "NotFound"`), shutdown is `runMain`'s job,
and a child process is released by closing a Scope.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| Node app/CLI/server entry | `NodeRuntime.runMain(program)` from `@effect/platform-node` | exit codes, SIGINT/SIGTERM interrupt fibers and run finalizers |
| Long-running app that is "just layers" (server, workers) | `NodeRuntime.runMain(Layer.launch(AppLayer))` | the layer is the app; shutdown closes it in reverse |
| Need FS + Path + spawner + stdio + terminal in Node | `Effect.provide(NodeServices.layer)` once, at the root | one layer, all five services |
| Only one capability | `NodeFileSystem.layer`, `NodePath.layer`, `NodeStdio.layer`, `NodeTerminal.layer`, `NodeChildProcessSpawner.layer` | smaller R in tests |
| Hashing, HMAC, secure random | `effect/crypto` services; `NodeCrypto.layer` (not in `NodeServices`) | see [encoding](../encoding/guide.md) |
| Pure path manipulation, no I/O | `Path.Path` service (`path.join`, `basename`, `resolve`) | portable separators; fakeable |
| Join an untrusted relative path under a root | `path.resolveWithin(root, input)` -> `Option<string>` | `None` for `..` escapes and absolute inputs |
| Find files by pattern | `fs.glob("**/*.ts", { root, exclude })` | sorted, relative paths; dotfiles skipped unless `dot: true` |
| Read/write whole files | `fs.readFileString`, `fs.writeFileString`, `readFile`, `writeFile` | typed `PlatformError` |
| Large files | `fs.stream(path)` -> `Stream<Uint8Array>`, `fs.sink(path)` | constant memory; see [streams](../streams/guide.md) |
| Temp files/dirs | `fs.makeTempDirectoryScoped`, `makeTempFileScoped` | removed when the Scope closes |
| Watch for changes | `fs.watch(path)` -> `Stream<WatchEvent>` | stream, interruptible |
| Run a command, capture output | `spawner.string` / `lines` / `exitCode` | whole lifecycle handled |
| Pass a secret to a child (env var or argument) | `Redacted.make(secret)` in `env` / args | never shows in logs or `CommandLine.display` |
| Interact with / stream a running child | `spawner.spawn(command)` in a Scope; `handle.all`, `handle.exitCode`; or `streamLines` | child killed when the Scope closes |
| Argv, stdin, stdout, stderr | `Stdio.Stdio` (`args`, `stdin`, `stdout()` sink) | testable with `Stdio.layerTest` |
| Interactive prompts, raw key input | `Terminal.Terminal` (`readLine`, `readInput`, `display`) | usually via [cli](../cli/guide.md) prompts |
| TCP/WebSocket client | `Socket.Socket` with `NodeSocket.*` layers | typed `SocketError`; see [http](../http/guide.md) for HTTP |
| CPU work off the main thread | `effect/workers` + `NodeWorker.layer` | message protocol with Schema |
| Browser, Bun, Deno | the matching `@effect/platform-browser` / `-bun` / `-deno` package | same core services, different layers; not installed here, so read its exports before use |
| Framework you do not control calls you (Hono, Next) | `ManagedRuntime` (see [services](../services/guide.md)) | one runtime for many calls |
| Not here | env/config -> [config](../config/guide.md); HTTP server/client -> [http](../http/guide.md); SQL -> [sql](../sql/guide.md) | |

## Recipe

A small report store: files in a directory, atomic writes, typed "not found",
and a streamed line count that never loads the file. First the pitfall.

```ts skip
// PITFALL: the domain function IS the platform. Untestable without a disk,
// errors are untyped `Error` with a magic `code`, "not found" leaks as an
// exception, writes are not atomic, and a 5 GB file is read into memory.
import { readFile, writeFile } from "node:fs/promises"
export async function read(name: string): Promise<string> {
  return readFile(`reports/${name}.txt`, "utf8") // name = "../../etc/passwd"
}
export async function lineCount(name: string) {
  return (await read(name)).split("\n").length // whole file in memory
}
export async function write(name: string, text: string) {
  await writeFile(`reports/${name}.txt`, text) // crash mid-write = corrupt file
}
```

The idiomatic version.

```ts import.meta.vitest name="references/platform/guide.md#2"
import { Context, Effect, FileSystem, Layer, Path, PlatformError, Schema, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

// The only failure a caller can act on. Everything else (disk full, permission
// denied) is an infrastructure fault nobody will branch on, so it is a defect.
export class ReportNotFound extends Schema.TaggedError<ReportNotFound>()("ReportNotFound", {
  name: Schema.String
}) {}

export class Reports extends Context.Service<Reports, {
  read(name: string): Effect.Effect<string, ReportNotFound>
  lineCount(name: string): Effect.Effect<number, ReportNotFound>
  write(name: string, text: string): Effect.Effect<void>
}>()("app/Reports") {
  // The layer's own requirements (FileSystem, Path) are interfaces from `effect`.
  // It does not know whether it runs on Node, Bun or a test double.
  static readonly layer = (dir: string) =>
    Layer.effect(
      Reports,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        // Setup is part of building the service: if the directory cannot be
        // created the app cannot start, which is exactly what a failed Layer means.
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)

        // basename() strips "../" so a name can never escape `dir`.
        const fileFor = (name: string) => path.join(dir, `${path.basename(name)}.txt`)

        // PlatformError carries a `reason`. catchReason turns exactly the
        // NotFound reason into our domain error; every other reason is an
        // infrastructure fault, so the remaining PlatformError becomes a defect.
        // (A blanket orDie here would also kill ReportNotFound, which is not
        // a PlatformError but is still in E at that point.)
        const notFound = (name: string) =>
          <A, R>(self: Effect.Effect<A, PlatformError.PlatformError, R>) =>
            self.pipe(
              Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(new ReportNotFound({ name }))),
              Effect.catchTag("PlatformError", Effect.die)
            )

        const read = Effect.fn("Reports.read")(function*(name: string) {
          return yield* fs.readFileString(fileFor(name)).pipe(notFound(name))
        })

        const lineCount = Effect.fn("Reports.lineCount")(function*(name: string) {
          // A byte stream, decoded and split lazily; memory stays flat.
          return yield* fs.stream(fileFor(name)).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runCount,
            notFound(name)
          )
        })

        const write = Effect.fn("Reports.write")(function*(name: string, text: string) {
          // Atomic replace: write a temp file on the SAME file system, then
          // rename. A crash leaves the old file or the new file, never half of
          // one. makeTempFileScoped puts the file in a fresh temp directory and
          // removes that directory when the Scope closes (Effect.scoped below),
          // on success and on failure.
          const tmp = yield* fs.makeTempFileScoped({ directory: dir, prefix: ".tmp-" })
          yield* fs.writeFileString(tmp, text)
          yield* fs.rename(tmp, fileFor(name))
        }, Effect.scoped, Effect.orDie)

        return Reports.of({ read, lineCount, write })
      })
    )
}

// Use case: only mentions Reports. It cannot tell if there is a disk at all.
export const archive = Effect.gen(function*() {
  const reports = yield* Reports
  yield* reports.write("daily", "a\nb\nc\n")
  return yield* reports.lineCount("daily")
})

// Composition root: the ONLY file that names a runtime. Here it is a test, so the
// directory is a scoped temp dir that disappears afterwards; in production you
// pass "./reports" (see the entry point below). `NodeServices.layer` satisfies
// the FileSystem | Path the Reports layer asks for.
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reports-" })
  const reports = Reports.layer(path.join(dir, "store"))

  const lines = yield* archive.pipe(Effect.provide(reports))
  const missing = yield* Reports.use((r) => r.read("nope")).pipe(Effect.flip, Effect.provide(reports))
  // A hostile name is flattened to its basename: nothing escapes the store directory.
  yield* Reports.use((r) => r.write("../../escape", "x")).pipe(Effect.provide(reports))
  const stored = yield* fs.readDirectory(path.join(dir, "store"))
  return { lines, missing: missing.name, stored: [...stored].sort() }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const result = await Effect.runPromise(program)
result // => { lines: 3, missing: "nope", stored: ["daily.txt", "escape.txt"] }
```

Things to take from it:

- **Provide narrow, assemble once.** `Layer.provide(NodeServices.layer)` feeds the
  Reports layer; the use case sees only `Reports`. If you instead
  `Effect.provide(NodeServices.layer)` on every call you would rebuild services each time.
- **Typed vs defect.** `ReportNotFound` is something a caller handles; `PlatformError`
  (the rest) becomes a defect at the service edge. If callers must distinguish
  "disk full" too, keep a `ReportStoreError` in `E` instead of `orDie`.
- **Resources are scoped by the API.** `fs.stream` and `fs.open` manage their handle;
  `makeTempDirectoryScoped` requires a `Scope`, so cleanup is a type-level obligation.
- **`runMain` requires `R = never`.** If it does not compile, a layer is missing.

### The process entry point

In production the composition root is one `runMain` call. This one is self-contained
and typechecked, but not a doctest because `runMain` owns the process (signals, exit code):

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"

const main = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const here = yield* fs.exists("package.json")
  yield* Effect.logInfo(`package.json present: ${here}`)
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(main)
```

For a long-running app, the layer is the program:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"

// A background worker expressed as a Layer: forkScoped ties the fiber to the
// layer's Scope, so shutdown interrupts it and runs its finalizers.
const Poller = Layer.effectDiscard(Effect.gen(function*() {
  yield* Effect.addFinalizer(() => Effect.logInfo("poller stopped"))
  yield* Effect.forkScoped(
    Effect.logInfo("tick").pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever)
  )
}))

// Layer.launch turns "build this layer and keep it alive" into Effect<never>.
// runMain installs SIGINT/SIGTERM handlers: Ctrl+C interrupts the fibers, the
// scope closes, finalizers run in reverse order, and the exit code is set.
NodeRuntime.runMain(Layer.launch(Poller), { disableErrorReporting: false })
```

### Running a command

```ts import.meta.vitest name="references/platform/guide.md#4"
import { NodeServices } from "@effect/platform-node"
import { Effect, Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class ScriptError extends Schema.TaggedError<ScriptError>()("ScriptError", {
  cause: Schema.Defect()
}) {}

// A tiny stand-in for any CLI: node itself, so the example runs anywhere Node does.
const node = (script: string, options?: ChildProcess.CommandOptions) =>
  ChildProcess.make("node", ["-e", script], options)

export const program = Effect.gen(function*() {
  // The spawner is a service, so this is faked in tests (see Testing).
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const out = yield* spawner.string(node("console.log('v' + (1 + 1))"))
  const lines = yield* spawner.lines(node("console.log('a'); console.log('b')"))
  const streamed = yield* Stream.runCollect(spawner.streamLines(node("console.log('x'); console.log('y')")))
  // A secret in env is a Redacted value: it reaches the child but never a log line.
  // Without extendEnv: true, `env` REPLACES the inherited environment (PATH included).
  const token = yield* spawner.string(
    node("console.log(process.env.API_TOKEN)", { env: { API_TOKEN: Redacted.make("s3cret") }, extendEnv: true })
  )
  return { out: out.trim(), lines, streamed, token: token.trim() }
}).pipe(Effect.mapError((cause) => new ScriptError({ cause })))

const result = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
result // => { out: "v2", lines: ["a", "b"], streamed: ["x", "y"], token: "s3cret" }
```

`spawner.string` / `lines` / `exitCode` run to completion. They fail with
`PlatformError` if the binary cannot start, but a **non-zero exit code is not a
failure**: check `exitCode` yourself (see [cheatsheet.md](cheatsheet.md)).

## Anti-patterns

**1. Importing `node:fs` in domain code.**

```ts skip
import { readFile } from "node:fs/promises"
const load = (p: string) => Effect.tryPromise(() => readFile(p, "utf8"))
```
Untyped error, uninterruptible read, no test double, and the module now only works on
Node. Use the service:

```ts import.meta.vitest name="references/platform/guide.md#6"
import { Effect, FileSystem } from "effect"
export const load = (p: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(p))
// Effect<string, PlatformError, FileSystem.FileSystem>
```

**2. Providing the platform layer inside a function.** `Effect.provide(NodeServices.layer)`
in a helper rebuilds services on every call and hides `R`. Provide at the root once.

**3. Swallowing `PlatformError` with a string.** `Effect.mapError(String)` throws away
`reason._tag` ("NotFound", "PermissionDenied", ...), the one thing callers need. Map the
reasons you handle (`Effect.catchReason`) and leave the rest.

**4. `runPromise`/`process.exit` in the middle.** `process.exit(1)` skips finalizers (open
files, spawned children, database pools). Fail the Effect and let `runMain` set the exit code.

**5. Trusting user-supplied path segments.** `path.join(dir, name)` with
`name = "../../x"` escapes `dir`. Use `path.resolveWithin(root, input)` (4.1), which returns
`Option.none()` when the result leaves the root or the input is absolute, or take
`path.basename(name)` when names are flat. The check is lexical (symlinks are not followed),
so it is not a sandbox on its own.

```ts import.meta.vitest name="references/platform/guide.md#5"
import { Effect, Option, Path } from "effect"

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  return {
    ok: path.resolveWithin("/srv/uploads", "avatars/ada.png"),
    escape: path.resolveWithin("/srv/uploads", "../etc/passwd"),
    absolute: path.resolveWithin("/srv/uploads", "/etc/passwd")
  }
}).pipe(Effect.provide(Path.layer))

const result = await Effect.runPromise(program)
result // => { ok: Option.some("/srv/uploads/avatars/ada.png"), escape: Option.none(), absolute: Option.none() }
```

**6. Reading a big file with `readFileString` then splitting.** Whole-file memory and no
backpressure. Use `fs.stream(path)` with `Stream.decodeText()` and `Stream.splitLines`.

**7. Non-atomic overwrite.** `writeFileString(target, ...)` leaves a torn file if the
process dies. Write a scoped temp file next to the target and `rename` it (as in the recipe).

**8. Leaking a spawned child.** `spawner.spawn` needs a `Scope`: wrap the interaction in
`Effect.scoped` so the child is killed with the scope, instead of keeping the handle past it.

**9. Importing a Node adapter in a shared package.** A library that does
`import "@effect/platform-node"` cannot run in the browser or Bun. Libraries depend on the
interfaces from `effect`; only applications import an adapter.

### Finding and reading parts of files

```ts import.meta.vitest name="references/platform/guide.md#9"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Option, Path } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "glob-" })
  yield* fs.makeDirectory(path.join(dir, "src", "nested"), { recursive: true })
  yield* fs.writeFileString(path.join(dir, "src", "a.ts"), "export const a = 1\n")
  yield* fs.writeFileString(path.join(dir, "src", "nested", "b.ts"), "export const b = 2\n")
  yield* fs.writeFileString(path.join(dir, "src", "nested", "b.test.ts"), "")
  yield* fs.writeFileString(path.join(dir, "src", ".hidden.ts"), "")

  // Sorted, relative to root, dotfiles skipped, excluded patterns pruned.
  const sources = yield* fs.glob("src/**/*.ts", { root: dir, exclude: ["**/*.test.ts"] })

  // Positional reads (4.1) take a bigint byte offset and leave the cursor alone.
  const file = yield* fs.open(path.join(dir, "src", "a.ts"))
  const slice = yield* file.readAlloc(5, { position: BigInt(7) })
  return { sources, slice: Option.map(slice, (bytes) => new TextDecoder().decode(bytes)) }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const result = await Effect.runPromise(program)
result // => { sources: ["src/a.ts", "src/nested/b.ts"], slice: Option.some("const") }
```

`fs.lstat` (stat without following symlinks) and `fs.readDirectoryEntries` (names with
a `File.Type`) are new in 4.1. `File.Info` fields `dev`, `ino`, `rdev`, `nlink` and
`blocks` are now `bigint`, so arithmetic on them needs `BigInt` literals.

## Testing it

The platform services are interfaces, so tests need no disk. `FileSystem.layerNoop`
builds a `FileSystem` where you override only the methods the code uses; every method you
do **not** override fails with a `NotFound` `PlatformError` (a missing stub looks like a
missing file, so stub deliberately). `Stdio.layerTest` does the same for argv/stdin/stdout.

```ts import.meta.vitest name="references/platform/guide.md#7"
import assert from "node:assert/strict"
import { Effect, FileSystem, PlatformError } from "effect"

// Code under test: depends only on the FileSystem interface.
const readVersion = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return (yield* fs.readFileString("VERSION")).trim()
})

const FsFake = FileSystem.layerNoop({
  readFileString: (path) =>
    path === "VERSION"
      ? Effect.succeed("4.0.0\n")
      : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" }))
})

const version = await Effect.runPromise(readVersion.pipe(Effect.provide(FsFake)))
assert.equal(version, "4.0.0")

// An un-stubbed method behaves like a missing file:
const failure = await Effect.runPromise(
  Effect.flip(FileSystem.FileSystem.use((fs) => fs.readFile("x"))).pipe(
    Effect.provide(FileSystem.layerNoop({}))
  )
)
assert.equal(failure.reason._tag, "NotFound")
```

For behaviour that depends on real file semantics (rename atomicity, permissions) write an
integration test against a scoped temp directory with the real layer. The directory is
deleted when the scope closes:

```ts import.meta.vitest name="references/platform/guide.md#8"
import assert from "node:assert/strict"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"

const test = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reports-test-" })
  yield* fs.writeFileString(path.join(dir, "a.txt"), "hello")
  assert.equal(yield* fs.readFileString(path.join(dir, "a.txt")), "hello")
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

await Effect.runPromise(test)
```

With `@effect/vitest`, the same Effects go inside `it.effect(...)`; `layer(...)` builds a
layer once for a group of tests (and tears it down after). The fence below is typechecked
and was run with Vitest:

```ts
import { assert, describe, it, layer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, PlatformError } from "effect"

// A real, tiny service over FileSystem, tested against an in-memory fake.
class Version extends Context.Service<Version, {
  readonly read: Effect.Effect<string>
}>()("app/Version") {
  static readonly layer = Layer.effect(
    Version,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return Version.of({ read: fs.readFileString("VERSION").pipe(Effect.map((text) => text.trim()), Effect.orDie) })
    })
  )
}

const FsFake = FileSystem.layerNoop({
  readFileString: (path) =>
    path === "VERSION"
      ? Effect.succeed("4.1.2\n")
      : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" }))
})

describe("Version", () => {
  // layer(...) provides the service to every test inside; the layer is built once.
  layer(Version.layer.pipe(Layer.provide(FsFake)))("with a fake file system", (it) => {
    it.effect("reads the trimmed version", () =>
      Effect.gen(function*() {
        const version = yield* Version
        assert.strictEqual(yield* version.read, "4.1.2")
      }))
  })

  it.effect("an un-stubbed method looks like a missing file", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(FileSystem.FileSystem.use((fs) => fs.readFile("x")))
      assert.strictEqual(error.reason._tag, "NotFound")
    }).pipe(Effect.provide(FileSystem.layerNoop({}))))
})
```

Child processes: provide a fake `ChildProcessSpawner.ChildProcessSpawner` via `Layer.succeed`
returning canned `string`/`lines`, and test the real spawner only in a few smoke tests.

## Changed in 4.1

- `NodeServices.layer` provides five services; **`Crypto` is gone from it** (the old
  `Crypto.Crypto` service became the `effect/crypto` modules). `NodeCrypto.layer` still
  exists in `@effect/platform-node`, with a native layer per crypto service.
- `Path.resolveWithin(root, input)` returns `Option<string>` and refuses escapes;
  `Path.make(impl)` builds a `Path` (deriving `resolveWithin`) for test doubles.
- `FileSystem`: `lstat`, `readDirectoryEntries`, `open(..., { noFollow })`, `glob` options
  (`dot`) with documented ordering, `File.read`/`readAlloc` take `{ position: bigint }`, and
  `File.Info.dev/ino/rdev/nlink/blocks` are `bigint`. `FileSystem.layerNoop` stubs the two
  new methods as `NotFound` too. `fs.watch` options accept `onReady`.
- `Stdio` has `stderrIsTerminal`; `Terminal` has `size`, a queue of resize events (scoped).
- Child processes: `env` and args accept `Redacted` values (`CommandLine.display` prints
  `<redacted>`), a `CommandLine` module (`quote`, `join`, `display`, `template`) exists,
  `ChildProcess.make` templates with a `shell` option build one script, and `exitCode`
  drains the child's output while waiting, so a chatty child cannot block on a full pipe.
- Sockets: `Socket.layerWebSocket(url, { headers })` accepts request headers; the string
  decoder no longer splits multi-byte characters across chunks.

## Boundaries

- [services](../services/guide.md): how `Context.Service`, `Layer` and `Scope` work; the `ManagedRuntime`
  bridge for frameworks. This skill only names which layers satisfy platform services.
- [streams](../streams/guide.md): `fs.stream`, `fs.sink`, `handle.all`, `Stdio.stdin` are Streams/Sinks;
  `NodeStream.fromReadable` wraps a Node `Readable`.
- [encoding](../encoding/guide.md): `effect/crypto` (`Digest`, `SecureRandom`, `Mac`) and byte/text
  codecs; crypto is not part of `NodeServices.layer` (use the web layers or `NodeCrypto.layer`).
- [http](../http/guide.md) / [http-api](../http-api/guide.md): `NodeHttpServer.layer(createServer, { port })` and
  `NodeHttpClient` come from the Node adapter; routing and clients belong there.
- [cli](../cli/guide.md): command-line apps, prompts and `Terminal`.
- [config](../config/guide.md): environment and secrets; do not read `process.env` here.
- [testing](../testing/guide.md): `it.effect`, `TestClock`, layer-based tests.
- [core](../core/guide.md): typed errors vs defects. `PlatformError` crosses out of this module
  as `E`; map it to a domain error at your service boundary.

## References

- [Cheat sheet: services, layers per runtime, signatures](cheatsheet.md)
- [FileSystem API](https://effect.website/docs/v4/api/effect/FileSystem)
- [Path API](https://effect.website/docs/v4/api/effect/Path)
- [PlatformError API](https://effect.website/docs/v4/api/effect/PlatformError)
- [@effect/platform-node](https://effect.website/docs/v4/api/platform-node)
- [Pinned FileSystem source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/FileSystem.ts)
- [Pinned NodeServices source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/platform/node/src/NodeServices.ts)
- [Pinned runMain example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/01_effect/06_running/10_run-main.ts)
- [Pinned child process example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/60_child-process/10_working-with-child-processes.ts)
