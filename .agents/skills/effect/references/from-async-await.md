# From async/await to Effect: rewrites

Each section shows the code people write first (left uncompiled), why it is
costly, and the idiom. Every compiled block is a standalone file.

## 1. A use case with failures

```ts skip
async function getUserEmail(id: string): Promise<string> {
  const res = await fetch(`https://api.example/users/${id}`)
  if (!res.ok) throw new Error("not found")
  const body = (await res.json()) as { email: string }
  return body.email
}
```

Problems: the signature says nothing about failure; `as` is unchecked; the
network is hard-wired; nothing can cancel it; tests need to mock `fetch`.

```ts import.meta.vitest name="references/from-async-await.md#2"
import { Context, Effect, Layer, Schema } from "effect"

class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: Schema.String
}) {}

// The capability is what the use case depends on, not `fetch`.
class UserDirectory extends Context.Service<UserDirectory, {
  find(id: string): Effect.Effect<{ readonly email: string }, UserNotFound>
}>()("app/UserDirectory") {
  static readonly layerTest = Layer.succeed(UserDirectory, {
    find: (id) =>
      id === "u1"
        ? Effect.succeed({ email: "ada@example.com" })
        : Effect.fail(new UserNotFound({ id }))
  })
}

const getUserEmail = Effect.fn("getUserEmail")(function*(id: string) {
  const directory = yield* UserDirectory
  const user = yield* directory.find(id)
  return user.email
})
// Effect<string, UserNotFound, UserDirectory>

await Effect.runPromise(getUserEmail("u1").pipe(Effect.provide(UserDirectory.layerTest))) // => "ada@example.com"
```

A real `layer` would implement `find` with `HttpClient` + `Schema` (see the
HTTP reference); the use case does not change.

## 2. try/catch → recover by name

```ts skip
try {
  return await loadConfig()
} catch {
  return defaults // hides every failure, including bugs
}
```

```ts import.meta.vitest name="from-async-await.md#4"
import { Effect, Schema } from "effect"

class ConfigMissing extends Schema.TaggedError<ConfigMissing>()("ConfigMissing", {
  key: Schema.String
}) {}

// A real (in-memory) source: succeeds only when the key is present.
const settings = new Map<string, string>([["host", "localhost"]])

const loadPort = Effect.suspend(() => {
  const raw = settings.get("port")
  return raw === undefined
    ? Effect.fail(new ConfigMissing({ key: "port" }))
    : Effect.succeed({ port: Number(raw) })
})

// Only ConfigMissing is recovered. A defect, or an error added to loadPort
// next month, still surfaces.
export const config = loadPort.pipe(
  Effect.catchTag("ConfigMissing", () => Effect.succeed({ port: 3000 }))
)

await Effect.runPromise(config) // => { port: 3000 }
```

## 3. Promise.all → bounded concurrency

```ts skip
const results = await Promise.all(ids.map((id) => fetchUser(id))) // 10_000 at once
```

```ts import.meta.vitest name="references/from-async-await.md#6"
import { Effect } from "effect"

// A real async lookup with a typed failure for unknown ids.
const directory = new Map([["u1", "Ada"], ["u2", "Lin"], ["u3", "Nia"]])

const fetchUser = (id: string): Effect.Effect<string, "NotFound"> =>
  Effect.promise(() => Promise.resolve(directory.get(id))).pipe(
    Effect.flatMap((name) => (name === undefined ? Effect.fail("NotFound" as const) : Effect.succeed(name)))
  )

export const fetchAll = (ids: ReadonlyArray<string>) =>
  Effect.forEach(ids, fetchUser, { concurrency: 2 })
// at most 2 lookups in flight; the first failure interrupts the rest

await Effect.runPromise(fetchAll(["u1", "u2", "u3"])) // => ["Ada", "Lin", "Nia"]
await Effect.runPromise(Effect.flip(fetchAll(["u1", "nope"]))) // => "NotFound"
```

## 4. Wrapping a throwing or promise API

```ts import.meta.vitest name="references/from-async-await.md#7"
import { Effect, Schema } from "effect"

class ParseFailure extends Schema.TaggedError<ParseFailure>()("ParseFailure", {
  cause: Schema.Defect()
}) {}

// Synchronous, may throw
export const parse = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new ParseFailure({ cause })
  })

// Promise-based; the AbortSignal lets interruption cancel the request
export const fetchText = (url: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { signal }).then((r) => r.text()),
    catch: (cause) => new ParseFailure({ cause })
  })
```

Always map the unknown `cause` into *your* tagged error at the wrapper, once.
Do not let `unknown` propagate.

## 5. Shared mutable state

```ts skip
let inflight = 0
async function handle() { inflight++; try { await work() } finally { inflight-- } }
```

```ts import.meta.vitest name="references/from-async-await.md#9"
import { Effect, Ref } from "effect"

// `work` fails on purpose to show the counter is restored anyway.
const work = Effect.fail("boom")

export const program = Effect.gen(function*() {
  const inflight = yield* Ref.make(0)
  const handle = Effect.acquireUseRelease(
    Ref.update(inflight, (n) => n + 1),
    () => work,
    () => Ref.update(inflight, (n) => n - 1)
  )
  yield* Effect.forEach([1, 2, 3], () => handle, { concurrency: "unbounded" }).pipe(Effect.ignore)
  return yield* Ref.get(inflight) // 0, even though `work` failed
})

await Effect.runPromise(program) // => 0
```

## 6. Retries and timeouts

```ts skip
for (let i = 0; i < 3; i++) { try { return await call() } catch { await sleep(100 * 2 ** i) } }
```

```ts import.meta.vitest name="from-async-await.md#11"
import { Effect, Schedule } from "effect"

// Fails transiently twice, then succeeds: a real flaky dependency.
let attempts = 0
const call: Effect.Effect<string, "Transient" | "Fatal"> = Effect.suspend(() =>
  ++attempts < 3 ? Effect.fail("Transient" as const) : Effect.succeed(`ok after ${attempts}`)
)

export const resilient = call.pipe(
  Effect.retry({
    schedule: Schedule.exponential("1 millis"),
    times: 3,
    while: (e) => e === "Transient" // never retry what cannot succeed
  }),
  Effect.timeout("5 seconds")
)

await Effect.runPromise(resilient) // => "ok after 3"
```

`Effect.retry` options are `schedule`, `times`, `while`, `until`. The source
runs once before any retry policy applies; defects and interruption are never
retried. Details are in the time reference.

## 7. Class-based dependency injection

```ts skip
class OrderService {
  constructor(private db: Db, private mailer: Mailer, private clock: Clock) {}
}
const service = new OrderService(new Db(cfg), new Mailer(cfg), new SystemClock())
```

Wiring by hand means every new dependency edits every call site, and nothing
tells you which were forgotten. In Effect each service reads its own
dependencies with `yield*`, `R` records them, and `Layer.provide` wires the
graph once — see the services reference for the full pattern.
