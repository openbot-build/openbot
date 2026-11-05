# Type-first development

Effect is built so that the compiler can check your design. *Type-first* means
you write the types — data, states, errors, service contracts, the signature of
each use case — **before** any function body, and treat compiler output as the
reviewer of that design. Bodies then become the easy, mostly mechanical part.

Why this fits Effect better than most libraries: `Effect<A, E, R>` already
carries three design facts in the type (result, failures, requirements). If you
write that type first, you have specified the behaviour a caller may rely on,
and the compiler refuses every implementation that does more, less, or
something different.

## The loop

1. **Model the data.** Write `Schema`s for domain values and for every state a
   thing can be in. The schema is the single source: `typeof S.Type` is the
   TypeScript type, `S` decodes untrusted input, `S.make` builds trusted values.
2. **Name the failures.** One tagged error class per outcome a caller will
   branch on. If you cannot name the caller's reaction, it is a defect, not a
   typed error.
3. **Write the service contracts.** `Context.Service<Self, { ...methods }>` with
   full method signatures and *no* implementation. This is your architecture:
   what each part may ask of the others.
4. **Write each use case's signature first**, including `E` and `R`, using
   `Effect.fn.Return<A, E, R>` on the generator. The body is then checked
   against your specification.
5. **Implement until it compiles.** Each error is a design question (table
   below), not a typing nuisance. Do not silence it with `as`, `any`, or by
   widening `E`.
6. **Provide layers.** The remaining `R` on the program is your to-do list;
   `R = never` means the application is wired.

## A complete pass, end to end

Domain: an order moves Draft → Paid → Shipped. The code below is the whole
loop — data, transitions, contract, use case, wiring — in one file that runs.

```ts import.meta.vitest name="type-first.md#order"
import { Context, Effect, Layer, Ref, Schema } from "effect"

// 1. Data first: states are a closed union; ids are branded.
export const OrderId = Schema.String.pipe(Schema.brand("OrderId"))
export type OrderId = typeof OrderId.Type

const Draft = Schema.TaggedStruct("Draft", { id: OrderId, items: Schema.Array(Schema.String) })
const Paid = Schema.TaggedStruct("Paid", { id: OrderId, items: Schema.Array(Schema.String), receipt: Schema.String })
const Shipped = Schema.TaggedStruct("Shipped", { id: OrderId, receipt: Schema.String, tracking: Schema.String })
export const Order = Schema.Union([Draft, Paid, Shipped])
export type Order = typeof Order.Type

// 2. Transitions are functions between *specific* states.
export const pay = (order: typeof Draft.Type, receipt: string): typeof Paid.Type => ({
  _tag: "Paid", id: order.id, items: order.items, receipt
})
export const ship = (order: typeof Paid.Type, tracking: string): typeof Shipped.Type => ({
  _tag: "Shipped", id: order.id, receipt: order.receipt, tracking
})

const draft = Draft.make({ id: OrderId.make("o1"), items: ["book"] })
// @ts-expect-error a Draft cannot be shipped: it has not been paid
ship(draft, "T1")

// 3. Exhaustive handling: add a state and this stops compiling.
export const label = (order: Order): string => {
  switch (order._tag) {
    case "Draft": return `draft with ${order.items.length} items`
    case "Paid": return `paid (${order.receipt})`
    case "Shipped": return `shipped (${order.tracking})`
  }
}

// 4. The service contract, written before any implementation.
export class OrderNotFound extends Schema.TaggedError<OrderNotFound>()("OrderNotFound", { id: OrderId }) {}
export class Orders extends Context.Service<Orders, {
  get(id: OrderId): Effect.Effect<Order, OrderNotFound>
  save(order: Order): Effect.Effect<void>
}>()("app/Orders") {
  static readonly layerMemory = Layer.effect(Orders, Effect.gen(function*() {
    const store = yield* Ref.make(new Map<OrderId, Order>())
    return Orders.of({
      get: (id) => Ref.get(store).pipe(
        Effect.flatMap((m) => { const o = m.get(id); return o ? Effect.succeed(o) : Effect.fail(new OrderNotFound({ id })) })
      ),
      save: (order) => Ref.update(store, (m) => new Map(m).set(order.id, order))
    })
  }))
}

// 5. Use case: the return type is written FIRST and checked against the body.
export const payOrder = Effect.fn("payOrder")(function*(id: OrderId, receipt: string): Effect.fn.Return<
  typeof Paid.Type,
  OrderNotFound | "NotDraft",
  Orders
> {
  const orders = yield* Orders
  const order = yield* orders.get(id)
  if (order._tag !== "Draft") return yield* Effect.fail("NotDraft" as const)
  const paid = pay(order, receipt)
  yield* orders.save(paid)
  return paid
})

const program = Effect.gen(function*() {
  const orders = yield* Orders
  yield* orders.save(draft)
  const paid = yield* payOrder(draft.id, "R-1")
  return label(paid)
}).pipe(Effect.provide(Orders.layerMemory))
await Effect.runPromise(program) // => "paid (R-1)"
```

What the types gave you here, with no tests written:

- `ship(draft, ...)` **does not compile** (the `@ts-expect-error` line proves
  it). The illegal transition is unrepresentable rather than "checked at runtime".
- `label` has no `default` branch. Add a `Cancelled` state to the union and
  `label` stops compiling until you handle it (the function's return type
  `string` is not satisfied by an implicit `undefined`).
- `payOrder`'s declared `E` is `OrderNotFound | "NotDraft"`. If someone later
  makes `Orders.get` fail with a new error, this signature rejects the body
  until the author decides what the new failure means for *this* use case.
- `OrderId` is not `string`: passing a raw string where an id is expected is a
  compile error, so ids cannot be mixed with receipts or tracking numbers.
- The program's `R` is `Orders` until `Effect.provide(Orders.layerMemory)`
  removes it. The compiler will not let you `runPromise` an unwired graph.

## Seven techniques

| Technique | In Effect terms | Prevents |
| --- | --- | --- |
| **Make illegal states unrepresentable** | closed union of `Schema.TaggedStruct`s, transition functions between specific variants | `status: string` plus nullable fields that must be "set together" |
| **Parse, don't validate** | `Schema.decodeUnknownEffect(S)` once at the boundary; everything inside takes `typeof S.Type` | re-validating, or trusting an unchecked cast |
| **Brand primitives** | `Schema.String.pipe(Schema.brand("OrderId"))` | swapping two `string` arguments |
| **One source of truth** | derive the TS type from the schema (`typeof S.Type`, `typeof S.Encoded` for the wire shape) | hand-written interface drifting from the validator |
| **Errors are a spec** | tagged error classes in `E`; `catchTag`/`catchTags` handle exactly those | `catch (e: unknown)` and silent swallowing |
| **Exhaustiveness** | `switch` on `_tag` with a declared return type; `Effect.catchTags` demands every tag you claim to handle | forgetting a case when the union grows |
| **Requirements as architecture** | `R` and `Layer<Out, E, In>` types read like a dependency diagram | hidden globals, circular wiring |

## Where to annotate, where to let inference work

| Position | Annotate? | Reason |
| --- | --- | --- |
| Service interface methods | **Always** (it is the contract) | callers and test doubles depend on it |
| Use-case return type | **Yes** via `Effect.fn.Return<A, E, R>` when the use case is a public seam; skip for small private helpers | turns the signature into a checked specification |
| Schema-derived types | **Derive**, never hand-write | no drift |
| Local variables, lambdas | **No** | noise; inference is exact |
| `R` of a program | **Never** annotate by hand | it must be *computed* so a missing layer is a visible error |
| Errors thrown by wrappers | Type them at the wrapper (`Effect.tryPromise({ catch })`) | converts `unknown` once |

## Reading compiler errors as design feedback

(Exact wording varies by TypeScript version; the meaning does not.)

| Compiler says | It means | Do |
| --- | --- | --- |
| `Type 'X' is not assignable to type 'never'` at `runPromise` | `R` is not empty: a service has no layer | provide the layer, or find which `yield*` introduced it |
| `Type 'Effect<…, A \| B, …>' is not assignable to … E …` | the body can fail in a way the signature does not admit | handle `B`, translate it (`mapError`), or widen the contract on purpose |
| `Argument of type 'string' is not assignable to 'OrderId'` | a raw value is crossing a typed boundary | decode (`Schema.decodeUnknownEffect`) or use the schema's `make` |
| `Function lacks ending return statement and return type does not include 'undefined'` on a `switch` over `_tag` | you forgot a variant | add the case; do not add `default` |
| `Not all code paths return a value` after `yield* new MyError()` | you forgot `return yield*` | `return yield* new MyError(...)` |
| `Property 'x' is missing in type …` for a service object | the implementation does not satisfy the contract | implement it; if the contract is wrong, change the contract first |

## Anti-patterns

```ts skip
// Optional fields as a state machine: nothing stops { status: "shipped" } without a tracking number.
interface Order { status: string; receipt?: string; tracking?: string }

// Separate interface and validator that can drift apart.
interface User { id: string; age: number }
const isUser = (u: any): u is User => typeof u.id === "string"

// Casting to silence the compiler: the design question is thrown away.
const order = (await db.get(id)) as Order

// E = unknown / Error: the signature says nothing a caller can use.
const getUser = (id: string): Effect.Effect<User, Error> => ...

// Annotating R by hand to make a missing layer "go away".
const program: Effect.Effect<void, never, never> = needsDatabase as any
```

Each of these deletes information the compiler could have enforced. The fix is
always to move the fact *into* a type (a union, a brand, a schema, a tagged
error) rather than into a comment, a naming convention, or a test.

## Type-level tests

A design rule you care about deserves a test that fails if the rule stops being
enforced. Use `// @ts-expect-error` (as above): it fails to compile when the
line becomes *valid*, which is exactly the regression you want to catch. This
repository typechecks every example, so these markers are verified on each run.

## When type-first is the wrong tool

Spiking an unknown third-party API: explore with `unknown` and quick scripts,
then write the types for what you learned. Type-first is a way to decide
shape, not a rule against exploration. The rule is: nothing leaves the spike
without a Schema at its boundary and a named error for every outcome.
