// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.make needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ComputersApi } from "@openbot-build/api"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Ref,
} from "effect"
import {
	FetchHttpClient,
	Headers,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { NetAddress } from "effect/net"
import * as Config from "../src/Config.ts"
import * as Machine from "../src/Machine.ts"
import * as Pair from "../src/Pair.ts"

/** A folder for the config files of the tests. All tests in this file share it. */
class Folder extends Context.Service<Folder, string>()(
	"@openbot-build/computer/test/Pair.test/Folder",
) {}

const folder = Layer.effect(
	Folder,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-computer-pair-",
		})
	}),
).pipe(
	Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
)

/**
 * A fake OpenBot. It answers each request with `app`.
 * It stops when the test's scope closes.
 */
const fakeOpenBot = Effect.fnUntraced(function* <E>(
	app: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		HttpServerRequest.HttpServerRequest
	>,
) {
	const server = yield* NodeHttpServer.make(createServer, {
		port: 0,
		host: "127.0.0.1",
	})
	yield* server.serve(app)
	return {
		url: yield* Effect.fromResult(NetAddress.formatUrl(server.address)),
	}
})

/** Pairs with OpenBot, and keeps what the machine shows to the person. */
const pair = Effect.fnUntraced(function* (url: string, file: string) {
	const shown = yield* Ref.make<ReadonlyArray<string>>([])
	const result = yield* Pair.pair({
		url,
		file,
		output: {
			showCode: (pairing, approveUrl) =>
				Ref.update(shown, Arr.appendAll([pairing.code, approveUrl])),
		},
	})
	return { ...result, shown: yield* Ref.get(shown) }
})

layer(folder, { excludeTestServices: true })((it) => {
	it.effect(
		"pair shows the code, polls until approval, and saves the token",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const starts = yield* Ref.make<
					ReadonlyArray<ComputersApi.StartPairingRequest>
				>([])
				// The authorization header of each poll.
				const polls = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
				const openbot = yield* fakeOpenBot(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						if (
							request.method === "POST" &&
							request.url === "/v1/hooks/computers/pairings"
						) {
							const start = yield* HttpServerRequest.schemaBodyJson(
								ComputersApi.StartPairingRequest,
							)
							yield* Ref.update(starts, Arr.append(start))
							return yield* HttpServerResponse.json(
								{
									id: "pairing-1",
									code: "KDTW-7Q3M",
									secret: "pairing-secret",
									interval: 1,
									expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
								},
								{ status: 201 },
							)
						}
						if (
							request.method === "POST" &&
							request.url === "/v1/hooks/computers/pairings/pairing-1/poll"
						) {
							const done = yield* Ref.updateAndGet(
								polls,
								Arr.append(Headers.get(request.headers, "authorization")),
							)
							const started = yield* Ref.get(starts)
							return yield* HttpServerResponse.json(
								done.length < 2
									? { _tag: "Pending" }
									: {
											_tag: "Approved",
											computer: "computer-1",
											token: `token-${started.length}`,
										},
							)
						}
						return yield* HttpServerResponse.json({}, { status: 404 })
					}),
				)
				const secret = Option.some("Bearer pairing-secret")
				const file = path.join(yield* Folder, "computer.json")
				const first = yield* pair(openbot.url, file)
				assert.strictEqual(first.computer, "computer-1")
				assert.deepStrictEqual(first.shown, [
					"KDTW-7Q3M",
					`${openbot.url}/v1/computer-pairings/KDTW-7Q3M/approve`,
				])
				assert.deepStrictEqual(yield* Ref.get(polls), [secret, secret])
				const start = yield* Effect.fromOption(Arr.head(yield* Ref.get(starts)))
				assert.strictEqual(start.desktop, false)
				assert.strictEqual(start.os, process.platform)
				assert.strictEqual(start.arch, process.arch)
				assert.strictEqual(start.hostname, Machine.name())
				assert.strictEqual(start.version, 2)
				assert.ok(start.machineId.length >= 16)
				assert.strictEqual(first.config.url, openbot.url)
				assert.strictEqual(first.config.machineId, start.machineId)
				assert.strictEqual(Redacted.value(first.config.token), "token-1")
				assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600)

				// A second pairing keeps the machine ID and saves the new token.
				yield* Ref.set(polls, [])
				const second = yield* pair(`${openbot.url}/`, file)
				assert.deepStrictEqual(yield* Ref.get(polls), [secret, secret])
				assert.deepStrictEqual(
					Arr.map(yield* Ref.get(starts), (started) => started.machineId),
					[start.machineId, start.machineId],
				)
				assert.strictEqual(Redacted.value(second.config.token), "token-2")
				const saved = yield* Config.read(file)
				assert.deepStrictEqual(
					Option.map(saved, (config) => Redacted.value(config.token)),
					Option.some("token-2"),
				)
			}),
	)

	it.effect(
		"pair stops with a clear message when OpenBot ends the pairing",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const openbot = yield* fakeOpenBot(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						if (request.url === "/v1/hooks/computers/pairings")
							return yield* HttpServerResponse.json(
								{
									id: "pairing-2",
									code: "AAAA-BBBB",
									secret: "s",
									interval: 1,
									expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
								},
								{ status: 201 },
							)
						return yield* HttpServerResponse.json(
							{ _tag: "PairingInvalid" },
							{ status: 404 },
						)
					}),
				)
				const file = path.join(yield* Folder, "denied.json")
				const error = yield* Effect.flip(pair(openbot.url, file))
				assert.match(error.message, /OpenBot ended this pairing/)
				assert.strictEqual(yield* fs.exists(file), false)
			}),
	)

	it.effect("pair asks again when a proxy answers a poll with 502", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const polls = yield* Ref.make(0)
			const openbot = yield* fakeOpenBot(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					if (request.url === "/v1/hooks/computers/pairings")
						return yield* HttpServerResponse.json(
							{
								id: "pairing-4",
								code: "EEEE-FFFF",
								secret: "s",
								interval: 1,
								expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
							},
							{ status: 201 },
						)
					return (yield* Ref.updateAndGet(polls, (n) => n + 1)) < 2
						? HttpServerResponse.text("Bad Gateway", { status: 502 })
						: yield* HttpServerResponse.json({
								_tag: "Approved",
								computer: "computer-4",
								token: "token-4",
							})
				}),
			)
			const result = yield* pair(
				openbot.url,
				path.join(yield* Folder, "proxy.json"),
			)
			assert.strictEqual(result.computer, "computer-4")
			assert.strictEqual(Redacted.value(result.config.token), "token-4")
			assert.strictEqual(yield* Ref.get(polls), 2)
		}),
	)

	it.effect(
		"pair stops at once when OpenBot answers a poll in a way it does not know",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const polls = yield* Ref.make(0)
				const openbot = yield* fakeOpenBot(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						if (request.url === "/v1/hooks/computers/pairings")
							return yield* HttpServerResponse.json(
								{
									id: "pairing-5",
									code: "GGGG-HHHH",
									secret: "s",
									interval: 1,
									expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
								},
								{ status: 201 },
							)
						yield* Ref.update(polls, (n) => n + 1)
						return yield* HttpServerResponse.json({ _tag: "Unknown" })
					}),
				)
				const file = path.join(yield* Folder, "unknown.json")
				const error = yield* Effect.flip(pair(openbot.url, file))
				assert.match(error.message, /OpenBot did not answer as expected/)
				assert.strictEqual(yield* Ref.get(polls), 1)
				assert.strictEqual(yield* fs.exists(file), false)
			}),
	)

	it.effect("pair names the reason when it cannot reach OpenBot", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			// fetch does not connect to port 1, and it says so in the cause of its error.
			const error = yield* Effect.flip(
				pair(
					"http://127.0.0.1:1",
					path.join(yield* Folder, "unreachable.json"),
				),
			)
			assert.strictEqual(
				error.message,
				"Could not reach OpenBot at http://127.0.0.1:1 (bad port).",
			)
			assert.ok(error.cause !== undefined)
		}),
	)

	it.effect("pair stops when the code expires", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const openbot = yield* fakeOpenBot(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					if (request.url === "/v1/hooks/computers/pairings")
						return yield* HttpServerResponse.json(
							{
								id: "pairing-3",
								code: "CCCC-DDDD",
								secret: "s",
								interval: 1,
								expiresAt: (yield* Clock.currentTimeMillis) + 500,
							},
							{ status: 201 },
						)
					return yield* HttpServerResponse.json({ _tag: "Pending" })
				}),
			)
			const error = yield* Effect.flip(
				pair(openbot.url, path.join(yield* Folder, "expired.json")),
			)
			assert.match(error.message, /Nobody approved the code in time/)
		}),
	)
})
