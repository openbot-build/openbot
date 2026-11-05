# Platform cheat sheet (effect@4.1.2, @effect/platform-node@4.1.2)

Everything here was read from `node_modules/effect/src/*.ts` and
`node_modules/@effect/platform-node{,-shared}/src/*.ts` (4.1.2).

## Where things live

| Capability | Interface (import from `effect`) | Node layer (`@effect/platform-node`) |
| --- | --- | --- |
| files | `FileSystem.FileSystem` | `NodeFileSystem.layer` |
| paths | `Path.Path` (also `Path.layer`, no I/O) | `NodePath.layer` |
| argv / stdin / stdout / stderr | `Stdio.Stdio` | `NodeStdio.layer` |
| interactive terminal | `Terminal.Terminal` | `NodeTerminal.layer` |
| child processes | `ChildProcessSpawner.ChildProcessSpawner` from `effect/process` | `NodeChildProcessSpawner.layer` |
| hashing, HMAC, secure random, ... | `Digest`, `Mac`, `SecureRandom`, ... from `effect/crypto` | web layers in `effect/crypto`, or `NodeCrypto.layer` (see [encoding](../encoding/cheatsheet.md)) |
| all five at once | | `NodeServices.layer` (type `NodeServices` = spawner, FileSystem, Path, Stdio, Terminal; **no crypto**) |
| TCP / TLS / WebSocket | `Socket.Socket` from `effect/socket` | `NodeSocket.layerNet`, `layerTls`, `layerWebSocket(url)`, `layerWebSocketConstructor` |
| socket server | `SocketServer` from `effect/socket` | `NodeSocketServer.*` |
| workers | `Worker`, `WorkerRunner` from `effect/workers` | `NodeWorker.layer(spawn)`, `NodeWorkerRunner.*` |
| HTTP server / client | `effect/http` | `NodeHttpServer.layer(createServer, { port })`, `layerTest`, `NodeHttpClient.layerUndici` / `layerNodeHttp` |
| Node streams | | `NodeStream.fromReadable`, `fromDuplex`, `toReadable`, `toString`, `toUint8Array` |
| entry point | | `NodeRuntime.runMain(effect, { disableErrorReporting?, teardown? })` |

`NodeCrypto.layer` provides every crypto service at once; there is also one native layer per
service (`layerDigest`, `layerMac`, `layerSecureRandom`, `layerKdf`, `layerAead`, `layerCipher`,
`layerSignature`, `layerKeyAgreement`, `layerKeyWrap`).

`NodeRuntime.runMain` takes `Effect<A, E>` with **no requirements**. Bun has the
same shape (`BunRuntime.runMain` appears in the upstream ai-docs), but
`@effect/platform-bun`, `-deno` and `-browser` are not installed in this
repository and their exports were not verified. After installing one, read
`node_modules/@effect/platform-<runtime>/dist/index.d.ts` before using it, and
keep the same rule: adapters only in the entry file.

## FileSystem (all `Effect<_, PlatformError>` unless noted)

```
access(path, { ok?, readable?, writable? })      exists(path): Effect<boolean>
readFile(path): Uint8Array                       readFileString(path, encoding?): string
writeFile(path, bytes, { flag?, mode? })         writeFileString(path, text, { flag?, mode? })
readDirectory(path, { recursive? }): string[]    glob(pattern, { root?, exclude?, dot? }): string[]
readDirectoryEntries(path): { name, type: File.Type }[]   // 4.1
makeDirectory(path, { recursive?, mode? })       remove(path, { recursive?, force? })
copy(from, to, { overwrite?, preserveTimestamps? })   copyFile(from, to)   rename(old, new)
stat(path): File.Info                            lstat(path): File.Info   // no symlink follow, 4.1
                                                 realPath, readLink, symlink, link, truncate, utimes, chmod, chown
makeTempDirectory / makeTempFile ({ directory?, prefix?, suffix? })      -> path (you clean up)
makeTempDirectoryScoped / makeTempFileScoped (same options)              -> path, needs Scope, removed on close
open(path, { flag?, mode?, noFollow? }): Effect<File, PlatformError, Scope>
    File: read(buf, { position?: bigint }), readAlloc(size, { position? }), write, writeAll, seek, sync, stat, truncate
stream(path, { bytesToRead?, chunkSize?, offset? }): Stream<Uint8Array, PlatformError>
sink(path, { flag?, mode? }): Sink<void, Uint8Array, never, PlatformError>
watch(path, { recursive?, onReady? }): Stream<WatchEvent, PlatformError>     WatchEvent = Create | Update | Remove (each has path)
```

`File.Info` (from `stat`/`lstat`/`File.stat`): `dev`, `ino`, `rdev`, `nlink`, `blocks` are `bigint` (4.1); `size` is a
`ByteSize`, `mode`/`uid`/`gid` are `number`. `glob` patterns: `*`/`?`/`**`/`{a,b}`/`[..]`; wildcards skip dotfiles unless
`dot: true` or the segment starts with `.`; results are sorted, `/`-separated and relative to `root`. The matcher alone is
`Glob.make(pattern)` / `Glob.match` / `Glob.escape` (`import { Glob } from "effect"`).

`OpenFlag = "r" | "r+" | "w" | "wx" | "w+" | "wx+" | "a" | "ax" | "a+" | "ax+"`.
`makeTempFile` creates a **fresh temp directory** under `directory` and a file in it;
after you `rename` the file out, the directory remains unless you use the `Scoped`
variant. Test doubles: `FileSystem.layerNoop(partial)`, `FileSystem.makeNoop(partial)`
(every method you omit fails with a `NotFound` PlatformError).

## PlatformError

`PlatformError` (`_tag: "PlatformError"`) has `reason: BadArgument | SystemError`.
`SystemError._tag` is one of `AlreadyExists | BadResource | Busy | InvalidData |
NotFound | PermissionDenied | TimedOut | UnexpectedEof | Unknown | WouldBlock | WriteZero`
and carries `module`, `method`, `pathOrDescriptor?`, `syscall?`, `cause?`.
Handle one reason with `Effect.catchReason("PlatformError", "NotFound", (reason) => ...)`.
Construct fakes with `PlatformError.systemError({ _tag, module, method })` and
`PlatformError.badArgument({ module, method })`.

## Path

`join, resolve, normalize, relative, dirname, basename(path, suffix?), extname, parse, format, isAbsolute, sep`
and `resolveWithin(root, input): Option<string>` (4.1; `None` if the result leaves `root` or `input` is absolute)
are synchronous; `fromFileUrl(url)` and `toFileUrl(path)` return `Effect<_, BadArgument>`.

## Stdio and Terminal

```
Stdio: args: Effect<ReadonlyArray<string>>, stdin: Stream<Uint8Array, PlatformError>,
       stdout(opts?) / stderr(opts?): Sink<void, string | Uint8Array, never, PlatformError>,
       stdinIsTerminal, stdoutIsTerminal, stderrIsTerminal (4.1): Effect<boolean>
Stdio.layerTest(partial)  // defaults: no args, empty stdin, draining sinks

Terminal: columns, rows: Effect<number>, size (4.1): Effect<Dequeue<{ columns, rows }, Cause.Done>, never, Scope>, readLine: Effect<string, QuitError>,
          readInput: Effect<Dequeue<UserInput, Cause.Done>, never, Scope>,
          display(text): Effect<void, PlatformError>
```

## Child processes (`import { ChildProcess, ChildProcessSpawner } from "effect/process"`)

```
ChildProcess.make(command, args?, { cwd?, env?, extendEnv?, shell?, detached?, stdin?, stdout?, stderr?, ... })
ChildProcess.make`git commit -m ${message}`   // template: each ${} is ONE argument; arrays add one per element
// args and env values may be Redacted<string>; without extendEnv: true, `env` REPLACES the inherited environment (PATH too)
ChildProcess.pipeTo(next)   // a | b
ChildProcess.setCwd / setEnv / prefix
spawner.string(cmd, { includeStderr? })      Effect<string, PlatformError>
spawner.lines(cmd, { includeStderr? })       Effect<Array<string>, PlatformError>
spawner.exitCode(cmd)                        Effect<ExitCode, PlatformError>
spawner.streamString(cmd) / streamLines(cmd) Stream<string, PlatformError>
spawner.spawn(cmd)                           Effect<ChildProcessHandle, PlatformError, Scope>
handle: pid, exitCode, isRunning, kill(opts?), stdin (Sink), stdout / stderr / all (Stream<Uint8Array>), getInputFd, getOutputFd, unref
```

`CommandLine` (`import { CommandLine } from "effect/process"`, 4.0.7+) builds strings for shells/SSH:
`quote`, `join`, `display(words)` (prints `Redacted` words as `<redacted>`, so it is safe to log), `template`.

`ExitCode` is a branded number: compare with `ChildProcessSpawner.ExitCode(0)`.

A non-zero exit is **not** an Effect failure. Turn it into one yourself:

```ts import.meta.vitest name="references/platform/cheatsheet.md#1"
import { NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Number
}) {}

// Run for the exit code only, then decide what "success" means.
export const requireSuccess = Effect.fn("requireSuccess")(function*(command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(ChildProcess.make(command, args)).pipe(Effect.orDie)
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new CommandFailed({ command, exitCode: code })
  }
})

const failure = await Effect.runPromise(
  requireSuccess("node", ["-e", "process.exit(3)"]).pipe(Effect.flip, Effect.provide(NodeServices.layer))
)
failure.exitCode // => 3

await Effect.runPromise(requireSuccess("node", ["-e", "0"]).pipe(Effect.provide(NodeServices.layer))) // => undefined
```

## Sockets and workers (not exercised in the recipes)

- `Socket.Socket` is a service; `Socket.toStream(socket)` gives
  `Stream<Uint8Array, SocketError>`, `Socket.toChannel` composes with
  `Stream.pipeThroughChannel` and the `Ndjson`/`SchemaBinary` channels from
  `effect/encoding`. `NodeSocket.layerWebSocket`/`Socket.layerWebSocket(url, { headers, protocols, openTimeout })` take request headers (4.1).
  `SocketError` has tagged `reason`s
  (`SocketReadError | SocketWriteError | SocketOpenError | SocketUpgradeError | SocketCloseError`).
- Workers: `Worker.WorkerPlatform` + `Worker.Spawner` are provided by
  `NodeWorker.layer((id) => new WorkerThreads.Worker(...))`. Messages cross a
  thread boundary, so they must be structured-clone friendly: define the
  request/response protocol with `Schema`, never send services or closures.

## v3 to v4

| v3 | v4 |
| --- | --- |
| `@effect/platform` (`FileSystem`, `Path`, `Terminal`, `Command`) | `effect` core (`FileSystem`, `Path`, `Terminal`, `effect/process`) |
| `NodeContext.layer` | `NodeServices.layer` |
| `NodeRuntime.runMain` | same name, from `@effect/platform-node` |
| `Command.make(...)`, `Command.string` | `ChildProcess.make(...)` + `spawner.string` |
| `Effect.Service` / `Context.Tag` | `Context.Service` |
| `PlatformError` with `_tag: "SystemError"` | `PlatformError` with `reason: SystemError \| BadArgument` |
| 4.0 `NodeServices.layer` incl. `Crypto` | 4.1: five services; crypto is `effect/crypto` / `NodeCrypto.layer` |
