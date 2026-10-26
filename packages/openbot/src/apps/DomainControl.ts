import { getServers, Resolver } from "node:dns/promises"
import { Array as Arr, Context, Effect, Layer, Schema } from "effect"

export class DomainControlUnavailable extends Schema.TaggedError<
	DomainControlUnavailable,
	{ readonly brand: unique symbol }
>()("DomainControlUnavailable", { cause: Schema.optional(Schema.Defect()) }) {}
export class DomainControl extends Context.Service<
	DomainControl,
	{
		readonly tokens: (
			hostname: string,
		) => Effect.Effect<ReadonlyArray<string>, DomainControlUnavailable>
	}
>()("@openbot-build/openbot/apps/DomainControl") {}

/** The resolver errors that say the domain has no such TXT records. */
const missingRecords = Schema.is(
	Schema.Struct({ code: Schema.Literals(["ENOTFOUND", "ENODATA"]) }),
)

export const layer = Layer.succeed(
	DomainControl,
	DomainControl.of({
		tokens: Effect.fn("DomainControl.tokens")(function* (hostname) {
			const records = yield* Effect.tryPromise({
				try: (signal) => {
					// Each call has its own resolver, because `cancel` stops every query of a resolver.
					const resolver = new Resolver()
					// A new Resolver does not take the servers that `setServers` gave the default resolver.
					resolver.setServers(getServers())
					signal.addEventListener("abort", () => resolver.cancel(), {
						once: true,
					})
					return resolver.resolveTxt("_openbot-verification." + hostname)
				},
				catch: (cause) => DomainControlUnavailable.make({ cause }),
			}).pipe(
				Effect.catchIf(
					(error) => missingRecords(error.cause),
					() => Effect.succeed([]),
				),
				Effect.timeout("10 seconds"),
				Effect.catchTag("TimeoutError", (cause) =>
					Effect.fail(DomainControlUnavailable.make({ cause })),
				),
			)
			return Arr.map(records, (parts) => Arr.join(parts, ""))
		}),
	}),
)
