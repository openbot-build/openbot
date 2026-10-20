import { resolveTxt } from "node:dns/promises"
import { Context, Effect, Layer, Schema } from "effect"

export class DomainControlUnavailable extends Schema.TaggedError<DomainControlUnavailable>()(
	"DomainControlUnavailable",
	{},
) {}
export class DomainControl extends Context.Service<
	DomainControl,
	{
		readonly tokens: (
			hostname: string,
		) => Effect.Effect<ReadonlyArray<string>, DomainControlUnavailable>
	}
>()("@openbot-build/platform/apps/DomainControl") {}

export const layer = Layer.succeed(DomainControl, {
	tokens: (hostname) =>
		Effect.tryPromise({
			try: () => resolveTxt("_openbot-verification." + hostname),
			catch: (error) =>
				Schema.is(
					Schema.Struct({ code: Schema.Literals(["ENOTFOUND", "ENODATA"]) }),
				)(error)
					? ("MissingRecords" as const)
					: ("Unavailable" as const),
		}).pipe(
			Effect.map((records) => records.map((parts) => parts.join(""))),
			Effect.catch((error) =>
				error === "MissingRecords"
					? Effect.succeed([])
					: Effect.fail(DomainControlUnavailable.make({})),
			),
		),
})
