import { assert, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer makes its server with the createServer function of Node.
import { createServer } from "node:http"
import {
	Array as Arr,
	ConfigProvider,
	Effect,
	HashSet,
	Layer,
	Ref,
	Result,
	Schema,
	String as Str,
} from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { fetch as undiciFetch, getGlobalDispatcher } from "undici"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import * as OutboundGuard from "../src/network/OutboundGuard.ts"
import * as OutboundPolicy from "../src/network/OutboundPolicy.ts"

/**
 * Starts a test HTTP server on 127.0.0.1. It counts the requests that reach
 * it, and it stops when the scope closes.
 */
const startHttp = Effect.fn("Outbound.startHttp")(function* (
	respond: (
		request: HttpServerRequest.HttpServerRequest,
		port: number,
	) => HttpServerResponse.HttpServerResponse,
) {
	const requests = yield* Ref.make(0)
	const server = yield* NodeHttpServer.make(createServer, {
		host: "127.0.0.1",
		port: 0,
	})
	if (server.address._tag === "UnixPathAddress")
		return yield* Effect.die(new Error("Expected a TCP address"))
	const port = server.address.port
	yield* server.serve(
		Effect.gen(function* () {
			yield* Ref.update(requests, (count) => count + 1)
			return respond(yield* HttpServerRequest.HttpServerRequest, port)
		}),
	)
	return { port, requests: Ref.get(requests) }
})

const parse = (input: string) => {
	const result = OutboundPolicy.parse(input)
	if (Result.isFailure(result)) return assert.fail(result.failure)
	return result.success
}

const readPolicy = Effect.service(OutboundPolicy.OutboundPolicy)

/** A fetch of undici failed. The cause is the error of undici. */
class FetchFailed extends Schema.TaggedError<
	FetchFailed,
	{ readonly brand: unique symbol }
>()("FetchFailed", { cause: Schema.Defect() }) {}

/** Whether a fetch failed because the guard blocked its target. */
const isBlocked = (
	error: unknown,
): error is TypeError & { readonly cause: OutboundGuard.OutboundBlocked } =>
	error instanceof TypeError &&
	Schema.is(OutboundGuard.OutboundBlocked)(error.cause)

it("the allow list takes IP addresses, IP ranges and exact host names", () => {
	const allow = parse(
		" 127.0.0.1, 10.0.0.0/8 ,::1,fd00::/8, Ollama.Internal., ,db_1",
	)
	assert.deepStrictEqual([...allow.hostnames].sort(), [
		"db_1",
		"ollama.internal",
	])
	assert.strictEqual(allow.networks.length, 4)
	for (const entry of [
		"*",
		"*.internal",
		"http://localhost",
		"localhost:11434",
		"10.0.0.0/33",
		"a b",
	])
		assert.ok(Result.isFailure(OutboundPolicy.parse(entry)), entry)
	assert.ok(Result.isSuccess(OutboundPolicy.parse("")))
})

it("the address rule opens only the listed private targets", () => {
	const allowAddress = OutboundPolicy.allowAddress(
		parse("10.1.0.0/16,127.0.0.1,ollama.internal"),
	)
	assert.strictEqual(allowAddress("8.8.8.8", "dns.google"), true)
	assert.strictEqual(allowAddress("10.1.2.3", "a.example"), true)
	assert.strictEqual(allowAddress("10.2.0.1", "a.example"), false)
	assert.strictEqual(allowAddress("127.0.0.1", "127.0.0.1"), true)
	assert.strictEqual(allowAddress("::ffff:127.0.0.1", "a.example"), true)
	assert.strictEqual(allowAddress("127.0.0.2", "a.example"), false)
	assert.strictEqual(allowAddress("169.254.169.254", "a.example"), false)
	assert.strictEqual(allowAddress("192.168.1.9", "OLLAMA.internal."), true)
	assert.strictEqual(
		OutboundPolicy.allowAddress(OutboundPolicy.empty)("127.0.0.1", "localhost"),
		false,
	)
})

it.effect(
	"the environment sets the allow list, and a bad entry stops start-up",
	() =>
		Effect.gen(function* () {
			const load = (env: Record<string, string>) =>
				EnvironmentConfiguration.load.pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown({
							OPENBOT_DATABASE_URL: "postgres://localhost/openbot",
							OPENBOT_CLUSTER_SECRET:
								"test-cluster-secret-with-at-least-32-characters",
							OPENBOT_SECRET_KEYS: "test:" + Str.repeat(32)("11"),
							...env,
						}),
					),
				)
			const empty = yield* load({})
			assert.strictEqual(HashSet.size(empty.outboundAllow.hostnames), 0)
			assert.strictEqual(empty.outboundAllow.networks.length, 0)
			const listed = yield* load({ OPENBOT_OUTBOUND_ALLOW: "localhost" })
			assert.ok(HashSet.has(listed.outboundAllow.hostnames, "localhost"))
			const invalid = yield* Effect.flip(
				load({ OPENBOT_OUTBOUND_ALLOW: "localhost:11434" }),
			)
			assert.match(
				invalid.message,
				/OPENBOT_OUTBOUND_ALLOW has an invalid entry "localhost:11434"/,
			)
			// The value was read, but it is not right.
			assert.strictEqual(invalid.cause._tag, "SchemaError")
		}),
)

it.live(
	"the global guard blocks private targets for fetch and the Effect HTTP client",
	() =>
		Effect.gen(function* () {
			const server = yield* startHttp(() => HttpServerResponse.text("ok"))
			const before = getGlobalDispatcher()
			yield* Effect.gen(function* () {
				assert.notStrictEqual(getGlobalDispatcher(), before)
				// FetchHttpClient sends each request with the global fetch, so these
				// calls check fetch and the Effect HTTP client together.
				for (const host of ["127.0.0.1", "[::1]"]) {
					const error = yield* Effect.flip(
						HttpClient.get(`http://${host}:${server.port}/`),
					)
					assert.ok(isBlocked(error.cause), host)
					assert.match(String(error.cause.cause), /OPENBOT_OUTBOUND_ALLOW/)
				}
				assert.strictEqual(yield* server.requests, 0)
				const policy = yield* readPolicy
				assert.strictEqual(policy.allowAddress("127.0.0.1", "127.0.0.1"), false)
			}).pipe(
				Effect.provide(
					Layer.merge(
						OutboundGuard.layer(OutboundPolicy.empty),
						FetchHttpClient.layer,
					),
				),
			)
			assert.strictEqual(getGlobalDispatcher(), before)
		}),
)

it.live(
	"the global guard lets a listed address through and shares the rule",
	() =>
		Effect.gen(function* () {
			const server = yield* startHttp(() => HttpServerResponse.text("ok"))
			yield* Effect.gen(function* () {
				const response = yield* HttpClient.get(
					`http://127.0.0.1:${server.port}/`,
				)
				assert.strictEqual(yield* response.text, "ok")
				const policy = yield* readPolicy
				assert.strictEqual(policy.allowAddress("127.0.0.1", "127.0.0.1"), true)
				assert.strictEqual(policy.allowAddress("127.0.0.2", "127.0.0.2"), false)
			}).pipe(
				Effect.provide(
					Layer.merge(
						OutboundGuard.layer(parse("127.0.0.1")),
						FetchHttpClient.layer,
					),
				),
			)
		}),
)

it.live("the guard checks the DNS answer and every redirect", () =>
	Effect.gen(function* () {
		const server = yield* startHttp((request, port) =>
			request.url === "/redirect"
				? HttpServerResponse.redirect(`http://127.0.0.1:${port}/`, {
						status: 302,
					})
				: HttpServerResponse.text("ok"),
		)
		let blocked: ReadonlyArray<string> = []
		const dispatcher = yield* Effect.acquireRelease(
			Effect.sync(() =>
				OutboundGuard.dispatcher({
					allowAddress: OutboundPolicy.allowAddress(parse("listed.test")),
					lookup: (_hostname, _options, callback) =>
						callback(null, [{ address: "127.0.0.1", family: 4 }]),
					onBlocked: (hostname) => {
						blocked = Arr.append(blocked, hostname)
					},
				}),
			),
			(dispatcher) => Effect.promise(() => dispatcher.close()),
		)
		/** Fetches with the dispatcher of the guard. */
		const get = (url: string) =>
			Effect.tryPromise({
				try: () => undiciFetch(url, { dispatcher }),
				catch: (cause) => FetchFailed.make({ cause }),
			})
		const listed = yield* get(`http://listed.test:${server.port}/`)
		assert.strictEqual(yield* Effect.promise(() => listed.text()), "ok")
		assert.ok(
			isBlocked(
				(yield* Effect.flip(get(`http://other.test:${server.port}/`))).cause,
			),
		)
		assert.ok(
			isBlocked(
				(yield* Effect.flip(get(`http://listed.test:${server.port}/redirect`)))
					.cause,
			),
		)
		assert.deepStrictEqual(blocked, ["other.test", "127.0.0.1"])
		assert.strictEqual(yield* server.requests, 2)
	}),
)
