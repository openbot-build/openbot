import { NodeServices } from "@effect/platform-node"
import { Network } from "@openbot-build/protocol"
import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { HttpRouter } from "effect/http"
import * as Authorization from "../src/Authorization.ts"
import * as Service from "../src/Service.ts"
import { Settings } from "../src/Scenarios.ts"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** Starts the full service in a scope. Each request uses the public HTTP routes. */
export const serve = Effect.fn("ProtocolTest.serve")(function* (
	origin: string,
	clock?: Clock.Clock,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const read = (relative: string) =>
		Effect.flatMap(
			path.fromFileUrl(new URL(relative, import.meta.url)),
			(file) => fs.readFileString(file),
		)
	const network = Layer.succeed(Network.Network, {
		identity: { owner: "test", scope: "public" },
		readDocument: (input) =>
			Effect.map(
				encodeJson({
					client_id: input.url,
					client_name: "Independent CIMD client",
					redirect_uris: [origin + "/callback"],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
				}),
				(text) => ({
					url: input.url,
					status: 200,
					headers: { "content-type": "application/json" },
					text,
				}),
			),
		execute: () => Effect.die(new Error("Unexpected business network request")),
	})
	const settings = yield* Schema.decodeEffect(Settings)({
		origin,
		allowedOrigins: [origin, "https://host.example"],
		uiHtml: yield* read("../dist/ui.html"),
		guideMarkdown: yield* read("../guide.md"),
	})
	const routes = Service.layer(settings).pipe(
		Layer.provide(Authorization.layer(origin).pipe(Layer.provide(network))),
		Layer.provide(NodeServices.layer),
		Layer.provideMerge(
			clock === undefined ? Layer.empty : Layer.succeed(Clock.Clock, clock),
		),
	)
	const app = yield* Effect.acquireRelease(
		Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
		(app) => Effect.promise(() => app.dispose()),
	)
	return (input: string | URL | Request, init?: RequestInit) =>
		app.handler(new Request(input, init))
})
