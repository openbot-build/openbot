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

export const layerWithLabels = ({
	aliases = [],
	lookup = (hostname) => resolveTxt(hostname),
}: {
	readonly aliases?: ReadonlyArray<string> | undefined
	readonly lookup?: typeof resolveTxt
} = {}) => {
	const labels = [...new Set(["_openbot-verification", ...aliases])]
	if (
		labels.some(
			(label) => !/^_[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/.test(label),
		)
	)
		throw new Error(
			"Developer verification DNS labels must be single underscore-prefixed labels.",
		)
	return Layer.succeed(DomainControl, {
		tokens: (hostname) =>
			Effect.forEach(labels, (label) =>
				Effect.tryPromise({
					try: () => lookup(label + "." + hostname),
					catch: (error) =>
						Schema.is(
							Schema.Struct({
								code: Schema.Literals(["ENOTFOUND", "ENODATA"]),
							}),
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
			).pipe(Effect.map((results) => results.flat())),
	})
}
export const layer = layerWithLabels()
