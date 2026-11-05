# `@effect/vitest` patterns

`@effect/vitest` is a separate package (`npm i -D vitest @effect/vitest`; keep it
at the same version as `effect`). It is installed in this repository, so every
fence below is a compiled `ts` snippet. They are not marked as doctests because
they are written for `*.test.ts` files and are run by Vitest itself, not by the
docs runner. They are adapted from the maintained examples in
`node_modules/effect/ai-docs/src/09_testing/` and `51_http-server/20_testing.ts`.

## Basics: `it.effect`, `it.live`, `it.effect.each`, `it.effect.prop`

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"

describe("@effect/vitest basics", () => {
  // The test body returns an Effect. Failure of the Effect fails the test.
  it.effect("runs Effect code with assert helpers", () =>
    Effect.gen(function*() {
      const upper = ["ada", "lin"].map((name) => name.toUpperCase())
      assert.deepStrictEqual(upper, ["ADA", "LIN"])
      assert.strictEqual(upper.length, 2)
      assert.isTrue(upper.includes("ADA"))
    }))

  it.effect.each([
    { input: " Ada ", expected: "ada" },
    { input: " Lin ", expected: "lin" }
  ])("parameterized normalization %#", ({ input, expected }) =>
    Effect.gen(function*() {
      assert.strictEqual(input.trim().toLowerCase(), expected)
    }))

  // it.effect runs with a TestClock: sleeping is virtual.
  it.effect("controls time with TestClock", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.sleep(60_000).pipe(Effect.as("done" as const)))
      yield* TestClock.adjust(60_000)
      assert.strictEqual(yield* Fiber.join(fiber), "done")
    }))

  // it.live runs with the real runtime services (real clock).
  it.live("uses real runtime services", () =>
    Effect.gen(function*() {
      const startedAt = Date.now()
      yield* Effect.sleep(1)
      assert.isTrue(Date.now() >= startedAt)
    }))

  // Property-based: Schema-derived arbitraries.
  it.effect.prop("reversing twice is identity", [Schema.String], ([value]) =>
    Effect.gen(function*() {
      assert.strictEqual(value.split("").reverse().reverse().join(""), value)
    }))
})
```

## Services with test layers

The upstream pattern: a test-only `Ref` service holds data, the test repo layer
is built on it, and `Layer.provideMerge` keeps the ref visible so tests can
inspect it.

```ts
import { assert, describe, it, layer } from "@effect/vitest"
import { Array, Context, Effect, Layer, Ref } from "effect"

export interface Todo { readonly id: number; readonly title: string }

export class TodoRepoTestRef extends Context.Service<TodoRepoTestRef, Ref.Ref<Array<Todo>>>()("app/TodoRepoTestRef") {
  static readonly layer = Layer.effect(TodoRepoTestRef, Ref.make(Array.empty()))
}

class TodoRepo extends Context.Service<TodoRepo, {
  create(title: string): Effect.Effect<Todo>
  readonly list: Effect.Effect<ReadonlyArray<Todo>>
}>()("app/TodoRepo") {
  static readonly layerTest = Layer.effect(
    TodoRepo,
    Effect.gen(function*() {
      const store = yield* TodoRepoTestRef
      const create = Effect.fn("TodoRepo.create")(function*(title: string) {
        const todos = yield* Ref.get(store)
        const todo = { id: todos.length + 1, title }
        yield* Ref.set(store, [...todos, todo])
        return todo
      })
      return TodoRepo.of({ create, list: Ref.get(store) })
    })
  ).pipe(Layer.provideMerge(TodoRepoTestRef.layer))
}

// One layer for the whole block, torn down in afterAll. State is SHARED
// between the tests: the second test sees the first test's todo.
layer(TodoRepo.layerTest)("TodoRepo", (it) => {
  it.effect("tests repository behavior", () =>
    Effect.gen(function*() {
      const repo = yield* TodoRepo
      assert.strictEqual((yield* repo.list).length, 0)
      yield* repo.create("Write docs")
      assert.strictEqual((yield* repo.list).length, 1)
    }))

  it.effect("layer is shared", () =>
    Effect.gen(function*() {
      const repo = yield* TodoRepo
      assert.strictEqual((yield* repo.list).length, 1)
    }))
})

// Per-test isolation: provide the layer inside each test instead.
describe("isolated", () => {
  it.effect("fresh state", () =>
    Effect.gen(function*() {
      const repo = yield* TodoRepo
      assert.strictEqual((yield* repo.list).length, 0)
    }).pipe(Effect.provide(TodoRepo.layerTest)))
})
```

## Asserting on the error channel

A real in-memory repository that fails with a typed error, and tests for both
endings. `Effect.flip` makes the error the success value; `Effect.exit` keeps
the whole outcome.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: Schema.String
}) {}

const users = new Map([["u1", { id: "u1", name: "Ada" }]])

const getById = (id: string) => {
  const user = users.get(id)
  return user ? Effect.succeed(user) : Effect.fail(new UserNotFound({ id }))
}

it.effect("returns a typed not-found", () =>
  Effect.gen(function*() {
    // Effect.flip: the error becomes the success value
    const error = yield* getById("missing").pipe(Effect.flip)
    assert.strictEqual(error._tag, "UserNotFound")
    assert.strictEqual(error.id, "missing")
  }))

it.effect("finds an existing user", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(getById("u1"))
    assert.isTrue(Exit.isSuccess(exit))
    assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : undefined, { id: "u1", name: "Ada" })
  }))
```

## HTTP API handlers

Upstream tests `HttpApi` implementations without a server using
`HttpApiTest.groups(Api, ["users"])` from `effect/http-api`, with
`layer(Layer.mergeAll(HandlersLayer, HttpServer.layerServices))`. See the
[http-api](../http-api/guide.md) skill and `ai-docs/src/51_http-server/20_testing.ts`.
