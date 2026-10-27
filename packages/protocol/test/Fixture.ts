import { NodeHttpServer } from "@effect/platform-node"
import {
	Array as Arr,
	Cause,
	Effect,
	FileSystem,
	Path,
	Predicate,
	Ref,
	Schema,
} from "effect"
import { HttpServerError, type HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no HTTPS server, so the test server is the one from Node.
import * as Https from "node:https"

/** A test HTTPS server on 127.0.0.1 with its own self-signed certificate. */
export interface HttpsServer {
	/** The Node server. Tests use it to see the connections. */
	readonly server: Https.Server
	/** The origin with the host name localhost, such as https://localhost:4000. */
	readonly origin: string
	/** The origin with the address 127.0.0.1, such as https://127.0.0.1:4000. */
	readonly ipOrigin: string
	/** The certificate as PEM text. A client gives it as its trusted CA. */
	readonly ca: string
}

/** OpenSSL did not make the test certificate. */
export class CertificateError extends Schema.TaggedError<
	CertificateError,
	{ readonly brand: unique symbol }
>()("CertificateError", {
	exitCode: Schema.Int,
}) {}

/** Makes a key and a certificate for localhost and 127.0.0.1. Their files go away at the end. */
const certificate = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const directory = yield* fs.makeTempDirectoryScoped({
			prefix: "protocol-test-",
		})
		const keyPath = path.join(directory, "key.pem")
		const certPath = path.join(directory, "cert.pem")
		const exitCode = yield* spawner.exitCode(
			ChildProcess.make(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-days",
					"1",
					"-keyout",
					keyPath,
					"-out",
					certPath,
					"-subj",
					"/CN=localhost",
					"-addext",
					"subjectAltName=DNS:localhost,IP:127.0.0.1",
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			),
		)
		if (exitCode !== 0) return yield* CertificateError.make({ exitCode })
		return {
			key: yield* fs.readFileString(keyPath),
			cert: yield* fs.readFileString(certPath),
		}
	}),
)

/**
 * Starts a test HTTPS server for an Effect HTTP app. The app reads the request
 * from `HttpServerRequest` and gives back an `HttpServerResponse`. A failure
 * of the app becomes an error response. Each request runs in its own fiber,
 * and the fiber stops when the client closes the connection. The server stops
 * when the scope closes. It closes all open connections first, so open event
 * streams do not keep it running.
 */
export const serveHttps = Effect.fn("Fixture.serveHttps")(function* <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
	// makeHandler runs the app in an uninterruptible region, as HttpRouter does
	// for a route that asks for it. Without this, a client that goes away cannot
	// stop the request, and a request that never ends keeps the scope open.
	const listener = yield* NodeHttpServer.makeHandler(
		Effect.interruptible(app),
		{
			scope: yield* Effect.scope,
		},
	)
	const { key, cert } = yield* certificate
	const server = Https.createServer({ key, cert }, listener)
	yield* Effect.acquireRelease(
		Effect.callback<void, HttpServerError.ServeError>((resume) => {
			const onError = (cause: Error) =>
				resume(Effect.fail(new HttpServerError.ServeError({ cause })))
			server.once("error", onError)
			server.listen(0, "127.0.0.1", () => {
				server.off("error", onError)
				resume(Effect.void)
			})
		}),
		() =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections()
				server.close((error) =>
					resume(error === undefined ? Effect.void : Effect.die(error)),
				)
			}),
	)
	const address = server.address()
	if (!Predicate.isObject(address))
		return yield* Effect.die(new Error("The test server has no TCP address"))
	const fixture: HttpsServer = {
		server,
		origin: `https://localhost:${address.port}`,
		ipOrigin: `https://127.0.0.1:${address.port}`,
		ca: cert,
	}
	return fixture
})

/**
 * Starts a test server for an app. A failed check in the app gives an error
 * response, and the test fails when the scope closes.
 */
export const serveChecked = Effect.fn("Fixture.serveChecked")(function* <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
	const failures = yield* Ref.make<ReadonlyArray<string>>([])
	yield* Effect.addFinalizer(() =>
		Effect.flatMap(Ref.get(failures), (found) =>
			Arr.isReadonlyArrayNonEmpty(found)
				? Effect.die(new Error(Arr.join(found, "\n")))
				: Effect.void,
		),
	)
	return yield* serveHttps(
		Effect.tapCause(app, (cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: Ref.update(failures, Arr.append(Cause.pretty(cause))),
		),
	)
})
