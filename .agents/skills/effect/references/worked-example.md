# Worked example: designing a feature the Effect way

Feature: *"Send a receipt after a successful payment. The email provider is
flaky. Never charge twice."* The point is the order of decisions, not the code
volume.

## Step 0 — the version you would write first

```ts skip
export async function checkout(cart: Cart) {
  const charge = await stripe.charge(cart.total)          // throws on decline
  await db.orders.insert({ cart, chargeId: charge.id })
  try { await mailer.send(cart.email, receipt(charge)) } catch (e) { console.error(e) }
  return charge.id
}
```

Unclear: what can fail and what the caller should do; how it is tested; what
happens on cancel; whether the mail retries; which of `stripe`, `db`, `mailer`
are globals.

## Step 1 — decide the failure model

| Failure | Caller can act? | Channel |
| --- | --- | --- |
| Card declined | yes, show message | `E`: `PaymentDeclined` |
| Provider down for the receipt | no; the order is already valid | handled inside: retry, then log; never reaches `E` |
| DB unreachable | no | defect (`orDie` inside the repository) |
| Malformed cart from the client | yes, 400 | `E`: `SchemaError` from the boundary decode |

## Step 2 — name the capabilities

`Payments` (charge), `Mailer` (send), `Orders` (record). Each is an interface
whose methods return Effects with *their own* small error types. Domain code
never sees Stripe, SMTP or SQL types.

## Step 3 — write the use case against the interfaces

```ts import.meta.vitest name="references/worked-example.md#2"
import { Clock, Context, Effect, Layer, Schedule, Schema } from "effect"

export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  reason: Schema.String
}) {}
export class MailFailed extends Schema.TaggedError<MailFailed>()("MailFailed", {
  to: Schema.String
}) {}

export class Payments extends Context.Service<Payments, {
  charge(cents: number): Effect.Effect<{ readonly id: string }, PaymentDeclined>
}>()("app/Payments") {}

export class Mailer extends Context.Service<Mailer, {
  send(to: string, body: string): Effect.Effect<void, MailFailed>
}>()("app/Mailer") {}

export class Orders extends Context.Service<Orders, {
  record(chargeId: string, at: number): Effect.Effect<void>
}>()("app/Orders") {}

export const checkout = Effect.fn("checkout")(function*(input: {
  readonly email: string
  readonly cents: number
}) {
  const payments = yield* Payments
  const orders = yield* Orders
  const mailer = yield* Mailer

  const charge = yield* payments.charge(input.cents)         // may fail: PaymentDeclined
  yield* orders.record(charge.id, yield* Clock.currentTimeMillis)

  // Receipt is best-effort: retry, then log and carry on. MailFailed never
  // escapes, so the caller's E stays exactly PaymentDeclined.
  yield* mailer.send(input.email, `Receipt ${charge.id}`).pipe(
    Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 3 }),
    Effect.catchTag("MailFailed", (e) => Effect.logWarning("receipt not sent", e.to))
  )
  return charge.id
})
// (input) => Effect<string, PaymentDeclined, Payments | Orders | Mailer>

// Test doubles are ordinary layers: deterministic, no network.
export const TestLayer = Layer.mergeAll(
  Layer.succeed(Payments, {
    charge: (cents) =>
      cents > 10_000
        ? Effect.fail(new PaymentDeclined({ reason: "limit" }))
        : Effect.succeed({ id: `ch_${cents}` })
  }),
  Layer.succeed(Mailer, { send: () => Effect.void }),
  Layer.succeed(Orders, { record: () => Effect.void })
)

await Effect.runPromise(
  checkout({ email: "a@b.c", cents: 500 }).pipe(Effect.provide(TestLayer))
) // => "ch_500"
```

Read what the types gave you for free:

- `PaymentDeclined` is the only failure; the handler can `catchTag` it and
  nothing else needs a branch.
- `R = Payments | Orders | Mailer`: the compiler refuses `runPromise` until the
  graph is complete.
- The clock is a service, so a test can pin time (`TestClock`) and skip the
  backoff delays instead of sleeping.

## Step 4 — production layers and the edge

Each real implementation is a `Layer.effect(Payments, ...)` that reads
`Config`, builds its client with `Effect.acquireRelease`, and maps SDK errors
into the small error types above (`Effect.tryPromise` + `catch`). Compose them
once:

```ts skip
const AppLayer = Layer.mergeAll(Payments.layer, Mailer.layer, Orders.layer).pipe(
  Layer.provide(SqlLive),
  Layer.provide(ConfigLive)
)
// HTTP handler:   handler.pipe(Effect.provide(AppLayer))   -- or ManagedRuntime
// Worker process: NodeRuntime.runMain(Layer.launch(WorkerLayer.pipe(Layer.provide(AppLayer))))
```

## What to copy from this

1. Failure table first. 2. One small interface per capability, errors
inside the interface. 3. Use case = straight-line `Effect.fn`. 4. Best-effort
steps swallow *their own* typed error, deliberately and visibly. 5. Test layer
written alongside the interface. 6. Provide once, at the edge.
