import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
// Sdk is not a public entry point, so this file uses the source modules.
import * as OAuthAuthorization from "../src/connections/OAuthAuthorization.ts"
import * as HttpNetwork from "../src/network/HttpNetwork.ts"
import * as Network from "../src/network/Network.ts"
import * as Sdk from "../src/network/Sdk.ts"
import * as NodeHttpServer from "../src/node/NodeHttpServer.ts"
import { serveHttps } from "./Fixture.ts"

const encoder = new TextEncoder()
const chunks = (...parts: ReadonlyArray<string>) =>
	Stream.fromIterable(Arr.map(parts, (part) => encoder.encode(part)))

const isTooLarge = (error: unknown) =>
	Schema.is(Network.NetworkError)(error) && error.reason === "TooLarge"

it.effect(
	"eventLimit counts each SSE event alone, also when a blank line is split between chunks",
	() =>
		Effect.gen(function* () {
			const event = `data: ${Str.repeat(40)("a")}`
			// Each event is smaller than the limit, but all of them together are larger.
			const passed = yield* chunks(
				`${event}\n\n`,
				`${event}\r`,
				`\n\r\n`,
				`${event}\r\r`,
				`${event}\n`,
				`\n${event}\n\n`,
			).pipe(HttpNetwork.eventLimit(64), Stream.runCollect)
			assert.strictEqual(passed.length, 6)
			// Two lines with no blank line between them are one event.
			const oneEvent = yield* Effect.flip(
				chunks(`${event}\n`, `${event}\n`).pipe(
					HttpNetwork.eventLimit(64),
					Stream.runDrain,
				),
			)
			assert.ok(isTooLarge(oneEvent))
			const total = yield* Effect.flip(
				chunks(`${event}\n\n`, `${event}\n\n`).pipe(
					HttpNetwork.limit(64),
					Stream.runDrain,
				),
			)
			assert.ok(isTooLarge(total))
		}),
)

it.live(
	"SDK fetch fails with TooLarge when a JSON body or one SSE event is larger than the message limit",
	() =>
		Effect.gen(function* () {
			const event = `data: ${Str.repeat(200)("a")}\n\n`
			const fixture = yield* serveHttps(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					if (request.url === "/large.json")
						return HttpServerResponse.text(
							`{"data":"${Str.repeat(2048)("a")}"}`,
							{ contentType: "application/json" },
						)
					if (request.url === "/events")
						return HttpServerResponse.text(Str.repeat(20)(event), {
							contentType: "text/event-stream",
						})
					if (request.url === "/endless")
						// One event that never ends.
						return HttpServerResponse.stream(
							Stream.make(event, `data: ${Str.repeat(2048)("a")}`).pipe(
								Stream.concat(Stream.never),
								Stream.encodeText,
							),
							{ contentType: "text/event-stream; charset=utf-8" },
						)
					return HttpServerResponse.text(`{"data":"small"}`, {
						contentType: "application/json",
					})
				}),
			)
			yield* Effect.gen(function* () {
				const sdkFetch = yield* Sdk.fetch({ maxMessageBytes: 1024 })
				const read = Effect.fn(function* (
					path: string,
					body: (response: Response) => Promise<unknown>,
				) {
					const response = yield* Effect.promise(() =>
						sdkFetch(fixture.ipOrigin + path),
					)
					return yield* Effect.tryPromise(() => body(response))
				})
				const small = yield* read("/small.json", (response) => response.json())
				assert.deepStrictEqual(small, { data: "small" })
				// The events together are larger than the limit, but each one is smaller.
				const events = yield* read("/events", (response) => response.text())
				assert.strictEqual(events, Str.repeat(20)(event))
				const json = yield* read("/large.json", (response) =>
					response.json(),
				).pipe(Effect.asVoid, Effect.flip)
				assert.ok(isTooLarge(json.cause), String(json.cause))
				const endless = yield* read("/endless", (response) =>
					response.text(),
				).pipe(Effect.asVoid, Effect.flip)
				assert.ok(isTooLarge(endless.cause), String(endless.cause))
			}).pipe(
				Effect.provide(
					NodeHttpServer.layerUserNetwork({
						owner: "alice",
						allowedOrigins: [fixture.ipOrigin],
						allowAddress: (ip) => ip === "127.0.0.1",
						ca: fixture.ca,
					}),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
	"the SDK owner stops a request that has not returned its headers",
	() =>
		Effect.gen(function* () {
			const owner = yield* Scope.fork(yield* Effect.scope)
			const started = yield* Deferred.make<void>()
			const stopped = yield* Ref.make(false)
			const request = Deferred.succeed(started, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Ref.set(stopped, true)),
			)
			const fetch = yield* Sdk.fetch().pipe(
				Scope.provide(owner),
				Effect.provideService(Network.Network, {
					identity: { scope: "user", owner: "alice" },
					execute: () => request,
					readDocument: () => request,
				}),
			)
			const pending = yield* Effect.tryPromise(() =>
				fetch("https://example.test/mcp"),
			).pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			yield* Scope.close(owner, Exit.void)
			assert.isTrue(yield* Ref.get(stopped))
			assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)))
		}),
)

it.effect("OAuth discovery keeps a network failure as a network failure", () =>
	Effect.gen(function* () {
		const failure = Network.NetworkError.make({
			reason: "BlockedTarget",
			message: "The target is blocked.",
		})
		const error = yield* OAuthAuthorization.discoverResource({
			resource: "https://example.test/mcp",
		}).pipe(
			Effect.provideService(Network.Network, {
				identity: { scope: "user", owner: "alice" },
				execute: () => Effect.fail(failure),
				readDocument: () => Effect.fail(failure),
			}),
			Effect.flip,
		)
		assert.strictEqual(error, failure)
	}),
)

it.effect("the SDK owner stops a response body that has not ended", () =>
	Effect.gen(function* () {
		const owner = yield* Scope.fork(yield* Effect.scope)
		const started = yield* Deferred.make<void>()
		const stopped = yield* Ref.make(false)
		const fetch = yield* Sdk.fetch().pipe(
			Scope.provide(owner),
			Effect.provideService(Network.Network, {
				identity: { scope: "user", owner: "alice" },
				readDocument: () => Effect.die("This request reads a stream."),
				execute: (request) =>
					Effect.succeed({
						url: request.url,
						status: 200,
						headers: {},
						body: Stream.fromEffectDrain(
							Deferred.succeed(started, undefined),
						).pipe(
							Stream.concat(Stream.never),
							Stream.ensuring(Ref.set(stopped, true)),
						),
					}),
			}),
		)
		const response = yield* Effect.promise(() =>
			fetch("https://example.test/mcp"),
		)
		const reading = yield* Effect.tryPromise(() => response.text()).pipe(
			Effect.forkScoped,
		)
		yield* Deferred.await(started)
		yield* Scope.close(owner, Exit.void)
		yield* Fiber.await(reading)
		assert.isTrue(yield* Ref.get(stopped))
	}),
)
