import {
	Array as Arr,
	Cause,
	Config,
	Effect,
	FileSystem,
	Layer,
	Option,
	pipe,
	Schema,
	SchemaIssue,
	String as Str,
} from "effect"
import { HttpRouter, HttpServerError } from "effect/http"
import {
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node"
import * as ProtocolNodeNetwork from "@openbot-build/protocol/NodeHttpServer"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTPS server.
import { createServer as createHttpsServer } from "node:https"
import * as Authorization from "./Authorization.ts"
import * as Service from "./Service.ts"
import { originPlaceholder } from "./Pages.ts"
import { Settings } from "./Scenarios.ts"

const tlsPaths = Config.all({
	key: Config.option(Config.String("PROTOCOL_TEST_TLS_KEY")),
	cert: Config.option(Config.String("PROTOCOL_TEST_TLS_CERT")),
}).pipe(
	Config.flatMap(({ key, cert }) =>
		Option.isSome(key) === Option.isSome(cert)
			? Config.succeed(Option.all({ key, cert }))
			: // The values are there but they do not go together, so this is a
				// schema error, not a source error (a source that could not be read).
				Config.fail(
					new Schema.SchemaError(
						new SchemaIssue.InvalidValue({
							message:
								"Set both PROTOCOL_TEST_TLS_KEY and PROTOCOL_TEST_TLS_CERT to enable local TLS.",
						}),
					),
				),
	),
)

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
		const paths = yield* tlsPaths
		const fs = yield* FileSystem.FileSystem
		const uiHtml = Str.replaceAll(
			originPlaceholder,
			origin,
		)(yield* fs.readFileString(new URL("./ui.html", import.meta.url).pathname))
		const settings = yield* Schema.decodeEffect(Settings)({
			origin,
			allowedOrigins: pipe(
				Str.split(origins, ","),
				Arr.map(Str.trim),
				Arr.filter(Str.isNonEmpty),
			),
			uiHtml,
			guideMarkdown: yield* fs.readFileString(
				new URL("../guide.md", import.meta.url).pathname,
			),
		})
		const network = ProtocolNodeNetwork.layerPublicNetwork()
		const auth = Authorization.layer(settings.origin).pipe(
			Layer.provide(network),
		)
		const tls = yield* Effect.transposeOption(
			Option.map(paths, ({ key, cert }) =>
				Effect.all({
					key: fs.readFileString(key),
					cert: fs.readFileString(cert),
				}),
			),
		)
		const server = Option.match(tls, {
			onNone: () => NodeHttpServer.layer(createServer, { host, port }),
			onSome: (tls) =>
				NodeHttpServer.layer(() => createHttpsServer(tls), { host, port }),
		})
		return HttpRouter.serve(Service.layer(settings).pipe(Layer.provide(auth)), {
			// Access logs stay off on purpose, as in the nginx config: OAuth codes
			// and callbacks do not belong in them. So only server failures (5xx)
			// are logged, without the request URL. Client aborts, shutdown, 404
			// and bad request bodies are not server failures.
			disableLogger: true,
			middleware: (app) =>
				Effect.tapCause(app, (cause) => {
					// The server adds the response to the cause as a defect. Take it
					// out first, as HttpMiddleware.logger does.
					const [response, failure] =
						HttpServerError.causeResponseStripped(cause)
					return response.status >= 500 &&
						Option.isSome(failure) &&
						!Cause.hasInterruptsOnly(failure.value)
						? Effect.logError("A request failed.", failure.value)
						: Effect.void
				}),
		}).pipe(Layer.provide(server))
	}),
).pipe(Layer.provide(NodeServices.layer))

NodeRuntime.runMain(Layer.launch(application))
