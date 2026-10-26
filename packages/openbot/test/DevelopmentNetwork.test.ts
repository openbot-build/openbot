import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Document, Network } from "@openbot-build/protocol"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as DevelopmentApps from "../src/app/DevelopmentApps.ts"
import { Authorization } from "../src/app/DevelopmentAuthorization.ts"
import * as DevelopmentBusiness from "../src/app/DevelopmentBusiness.ts"
import type { Mode } from "../src/app/DevelopmentScenarios.ts"

const Reply = Schema.fromJsonString(
	Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }),
)
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** The simulated App in one scenario, with no sign-in step. */
const app = (mode: Mode) =>
	DevelopmentApps.layerNetwork.pipe(
		Layer.provide(
			Layer.succeed(
				Authorization,
				Authorization.of({
					scenario: Effect.succeed(mode),
					document: () => Effect.die("The test reads no document."),
					validToken: () => Effect.succeed(true),
					grant: () => Effect.die("The test gives no token."),
					consent: () => Effect.die("The test gives no consent."),
				}),
			),
		),
		Layer.provide(DevelopmentBusiness.layer),
		Layer.provide(NodeServices.layer),
	)

/** Sends one JSON-RPC request to the simulated App, and gives the result. */
const send = Effect.fn("DevelopmentNetwork.send")(function* (
	method: string,
	params: unknown,
) {
	const apps = yield* AppNetwork
	const services = yield* Layer.build(apps.layer("owner", []))
	const network = Context.get(services, Network.Network)
	const response = yield* network.execute(
		HttpClientRequest.post("https://app.development.test/mcp").pipe(
			HttpClientRequest.bodyText(
				yield* toJson({ jsonrpc: "2.0", id: 1, method, params }),
				"application/json",
			),
		),
	)
	const text = yield* Stream.mkString(Stream.decodeText(response.body))
	return (yield* Schema.decodeEffect(Reply)(text)).result
})

it.effect(
	"the simulated App asks for input, and reads the document after the person accepts",
	() =>
		Effect.gen(function* () {
			const asked = yield* send("tools/call", {
				name: "read_document",
				arguments: { id: "a" },
			})
			assert.strictEqual(asked["resultType"], "input_required")
			assert.isString(asked["requestState"])
			const read = yield* send("tools/call", {
				name: "read_document",
				arguments: { id: "a" },
				requestState: asked["requestState"],
				inputResponses: {
					consent: { action: "accept", content: { confirmed: true } },
				},
			})
			assert.deepStrictEqual(read["structuredContent"], {
				id: "a",
				text: "Simulated document content for a",
				handlerExecutions: 1,
			})
		}).pipe(Effect.scoped, Effect.provide(app("input-required"))),
)

it.effect("the simulated App gives its view as an App resource", () =>
	Effect.gen(function* () {
		const result = yield* send("resources/read", {
			uri: "ui://development/document",
		})
		const contents = yield* Schema.decodeUnknownEffect(
			Schema.Tuple([
				Schema.Struct({ uri: Schema.String, mimeType: Schema.String }),
			]),
		)(result["contents"])
		assert.strictEqual(contents[0].uri, "ui://development/document")
		assert.strictEqual(contents[0].mimeType, Document.uiMediaType)
	}).pipe(Effect.scoped, Effect.provide(app("available"))),
)

it.effect("the simulated App refuses a tool call with no tool name", () =>
	Effect.gen(function* () {
		const error = yield* send("tools/call", { arguments: { id: "a" } }).pipe(
			Effect.flip,
		)
		assert.strictEqual(error._tag, "SchemaError")
	}).pipe(Effect.scoped, Effect.provide(app("available"))),
)
