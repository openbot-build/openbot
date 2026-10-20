import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import {
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import * as ProtocolNodeNetwork from "@openbot-build/protocol/NodeHttpServer"
import { createServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import * as Authorization from "./Authorization.ts"
import * as Service from "./Service.ts"
import { originPlaceholder } from "./Pages.ts"
import { Settings } from "./Scenarios.ts"

const application = Layer.unwrap(
	Effect.gen(function* () {
		const origin = yield* Config.String("PROTOCOL_TEST_PUBLIC_ORIGIN")
		const host = yield* Config.String("PROTOCOL_TEST_HOST").pipe(
			Config.withDefault("0.0.0.0"),
		)
		const port = yield* Config.Int("PROTOCOL_TEST_PORT").pipe(
			Config.withDefault(3001),
		)
		const origins = yield* Config.String("PROTOCOL_TEST_ALLOWED_ORIGINS").pipe(
			Config.withDefault(origin),
		)
		const keyPath = yield* Config.option(Config.String("PROTOCOL_TEST_TLS_KEY"))
		const certPath = yield* Config.option(
			Config.String("PROTOCOL_TEST_TLS_CERT"),
		)
		if (Option.isSome(keyPath) !== Option.isSome(certPath))
			return yield* Effect.die(
				new Error(
					"Set both PROTOCOL_TEST_TLS_KEY and PROTOCOL_TEST_TLS_CERT to enable local TLS.",
				),
			)
		const fs = yield* FileSystem.FileSystem
		const uiHtml = (yield* fs.readFileString(
			new URL("./ui.html", import.meta.url).pathname,
		)).replaceAll(originPlaceholder, origin)
		const settings = yield* Schema.decodeEffect(Settings)({
			origin,
			allowedOrigins: origins
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
			uiHtml,
			guideMarkdown: yield* fs.readFileString(
				new URL("../guide.md", import.meta.url).pathname,
			),
		})
		const network = ProtocolNodeNetwork.layerPublicNetwork()
		const auth = Authorization.layer(settings.origin).pipe(
			Layer.provide(network),
		)
		const server =
			Option.isSome(keyPath) && Option.isSome(certPath)
				? NodeHttpServer.layer(
						() => createHttpsServer({ key: tlsKey, cert: tlsCert }),
						{ host, port },
					)
				: NodeHttpServer.layer(createServer, { host, port })
		const tlsKey = Option.isSome(keyPath)
			? yield* fs.readFileString(keyPath.value)
			: ""
		const tlsCert = Option.isSome(certPath)
			? yield* fs.readFileString(certPath.value)
			: ""
		return HttpRouter.serve(Service.layer(settings).pipe(Layer.provide(auth)), {
			disableLogger: true,
		}).pipe(Layer.provide(server))
	}),
).pipe(Layer.provide(NodeServices.layer))

NodeRuntime.runMain(Layer.launch(application))
