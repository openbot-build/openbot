import { assert, it } from "@effect/vitest"
import {
	Cause,
	Effect,
	Exit,
	Layer,
	Logger,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as Client from "../src/connections/Client.ts"
import * as CatalogDiscovery from "../src/discovery/CatalogDiscovery.ts"
import * as RobotsPolicy from "../src/discovery/RobotsPolicy.ts"
import * as Indexing from "../src/indexing/Indexing.ts"
import * as PublicIndexing from "../src/indexing/PublicIndexing.ts"
import * as Network from "../src/network/Network.ts"

const cardUrl = "https://publisher.example/card"
const inspect = (read: Network.PublicNetwork["Service"]["readDocument"]) =>
	Indexing.inspect(Indexing.Input.make({ cardUrl })).pipe(
		Effect.provide(
			PublicIndexing.layerInspection.pipe(
				Layer.provide(RobotsPolicy.layer),
				Layer.provide(CatalogDiscovery.layerRules),
				Layer.provide(
					Layer.succeed(Network.PublicNetwork, { readDocument: read }),
				),
			),
		),
	)
const privateCause = (result: Indexing.InspectionResult) =>
	Redacted.value(Option.getOrThrow(Client.errorCause(result)))
const encode = Schema.encodeEffect(
	Schema.fromJsonString(Indexing.InspectionResult),
)
const readCard =
	(
		read: Effect.Effect<Network.DocumentResponse, Network.NetworkError>,
	): Network.PublicNetwork["Service"]["readDocument"] =>
	({ url }) =>
		Str.endsWith("/robots.txt")(url)
			? Effect.succeed({ url, status: 404, headers: {}, text: "" })
			: read

it.effect(
	"an unconfirmed public check keeps all private network reasons without a raw log",
	() => {
		let messages: ReadonlyArray<unknown> = []
		const logger = Logger.layer([
			Logger.make((log) => {
				messages = [
					...messages,
					{ message: log.message, cause: Cause.pretty(log.cause) },
				]
			}),
		])
		return Effect.gen(function* () {
			const cause = Cause.combine(
				Cause.fail(
					Network.NetworkError.make({
						reason: "Timeout",
						message: "private-network-message",
						cause: new Error("private-network-cause"),
					}),
				),
				Cause.fail(
					Network.NetworkError.make({
						reason: "Timeout",
						message: "private-second-network-error",
					}),
				),
			)
			const result = yield* Effect.failCause(cause).pipe(readCard, inspect)
			assert.strictEqual(result._tag, "Unconfirmed")
			assert.notMatch(yield* encode(result), /private-/)
			const saved = Cause.pretty(privateCause(result))
			assert.match(saved, /private-network-message/)
			assert.match(saved, /private-network-cause/)
			assert.match(saved, /private-second-network-error/)
			assert.notMatch(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					messages,
				),
				/private-/,
			)
		}).pipe(Effect.provide(logger))
	},
)

it.effect(
	"an unconfirmed public Card keeps schema details outside its safe issue",
	() =>
		Effect.gen(function* () {
			const result = yield* Effect.succeed({
				url: cardUrl,
				status: 200,
				headers: { "content-type": "application/json" },
				text: '{"$schema":"private-card-value"}',
			}).pipe(readCard, inspect)
			assert.strictEqual(result._tag, "Unconfirmed")
			assert.notMatch(yield* encode(result), /private-/)
			const failure = Option.getOrThrow(
				Cause.findErrorOption(privateCause(result)),
			)
			assert.isTrue(Schema.isSchemaError(failure))
			if (!Schema.isSchemaError(failure)) return
			assert.match(failure.message, /\["\$schema"\]/)
			assert.match(
				Cause.pretty(privateCause(result)),
				/PublicationInspection.inspect/,
			)
		}),
)

it.effect(
	"a broken public reader keeps its defect and every failed reason",
	() =>
		Effect.gen(function* () {
			const cause = Cause.combine(
				Cause.fail(
					Network.NetworkError.make({
						reason: "Timeout",
						message: "private-failed-read",
					}),
				),
				Cause.die(new Error("private-reader-defect")),
			)
			const result = yield* Effect.failCause(cause).pipe(
				readCard,
				inspect,
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				assert.match(Cause.pretty(result.cause), /private-failed-read/)
				assert.match(Cause.pretty(result.cause), /private-reader-defect/)
			}
		}),
)

it.effect("stopping a public check stays an interruption", () =>
	Effect.gen(function* () {
		const result = yield* Effect.interrupt.pipe(readCard, inspect, Effect.exit)
		assert.isTrue(Exit.isFailure(result))
		if (Exit.isFailure(result))
			assert.isTrue(Cause.hasInterruptsOnly(result.cause))
	}),
)
