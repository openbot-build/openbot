import { Redacted } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Network, NetworkError } from "@openbot-build/protocol/Network"
import {
	Array as Arr,
	Context,
	Effect,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { Target } from "../src/channels/Channel.ts"
import * as CustomChannel from "../src/channels/custom/CustomChannel.ts"
import * as Http from "../src/channels/Http.ts"
import * as LarkChannel from "../src/channels/lark/LarkChannel.ts"
import { hmacHex } from "../src/channels/Text.ts"

/** A guarded network that fails each request with this failure. */
const failingNetwork = (failure: NetworkError | Schema.SchemaError) =>
	Context.make(Network, {
		identity: { scope: "user", owner: "channel:test" },
		execute: () => Effect.fail(failure),
		readDocument: () => Effect.die("not used"),
	})

it.effect(
	"A platform that cannot be reached does not put its address in the message",
	() =>
		Effect.gen(function* () {
			const client = HttpClient.make((request) =>
				Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({
							request,
							cause: "connection reset",
						}),
					}),
				),
			)
			const failure = yield* Effect.flip(
				Http.fromClient(client)(
					HttpClientRequest.post(
						"https://api.telegram.org/bot123456:secret-token/sendMessage",
					),
				),
			)
			assert.strictEqual(failure.retry, true)
			assert.notInclude(failure.message, "secret-token")
			assert.include(failure.message, "TransportError")
			assert.include(failure.message, "api.telegram.org")
			assert.strictEqual(failure.cause, "connection reset")
		}),
)

it.effect(
	"A custom Channel tries again only when a failure can pass on the next try",
	() =>
		Effect.gen(function* () {
			const request = HttpClientRequest.post("https://custom.example.com/hook")
			const retryOf = (failure: NetworkError | Schema.SchemaError) =>
				Http.fromNetwork(failingNetwork(failure))(request).pipe(
					Effect.flip,
					Effect.map((error) => error.retry),
				)
			const reasons = [
				"Transport",
				"Timeout",
				"BlockedTarget",
				"Redirect",
			] as const
			const retries = yield* Effect.forEach(reasons, (reason) =>
				retryOf(NetworkError.make({ reason, message: "test failure" })),
			)
			assert.deepStrictEqual(retries, [true, true, false, false])
			const badAddress = yield* Effect.flip(
				Schema.decodeUnknownEffect(Schema.String)(1),
			)
			const failure = yield* Effect.flip(
				Http.fromNetwork(failingNetwork(badAddress))(request),
			)
			assert.strictEqual(failure.retry, false)
			assert.strictEqual(
				failure.message,
				"The address of the custom Channel is not valid",
			)
			assert.strictEqual(failure.cause, badAddress)
		}),
)

const larkSecrets: LarkChannel.Secrets = {
	domain: "feishu",
	appId: "cli_test",
	appSecret: Redacted.make("lark-app-secret"),
	verificationToken: Redacted.make("lark-token"),
	encryptKey: Redacted.make("lark-encrypt-key"),
}

const isTokenRequest = (request: HttpClientRequest.HttpClientRequest) =>
	Str.endsWith("/tenant_access_token/internal")(request.url)

// The token request waits on the real clock, so the sends overlap.
it.live(
	"Lark asks for one tenant token when many messages go out at once",
	() =>
		Effect.gen(function* () {
			const tokenRequests = yield* Ref.make(0)
			const call: Http.Call = (request) =>
				isTokenRequest(request)
					? Ref.update(tokenRequests, (count) => count + 1).pipe(
							Effect.andThen(Effect.sleep("50 millis")),
							Effect.as({
								status: 200,
								headers: {},
								json: { code: 0, tenant_access_token: "t-1", expire: 7200 },
							}),
						)
					: Effect.succeed({
							status: 200,
							headers: {},
							json: { code: 0, data: { chat_id: "oc_1", message_id: "om_1" } },
						})
			const channel = yield* LarkChannel.make(larkSecrets, call)
			yield* Effect.forEach(
				Arr.range(1, 4),
				() =>
					channel.send(
						Target.Conversation({ conversation: "oc_1" }),
						{
							markdown: "hello",
						},
						"message-key",
					),
				{ concurrency: "unbounded" },
			)
			assert.strictEqual(yield* Ref.get(tokenRequests), 1)
		}).pipe(Effect.provide(NodeCrypto.layer)),
)

it.effect("A Lark tenant token failure keeps the reason that Lark gave", () =>
	Effect.gen(function* () {
		const call: Http.Call = () =>
			Effect.succeed({
				status: 200,
				headers: {},
				json: { code: 10003, msg: "invalid param" },
			})
		const channel = yield* LarkChannel.make(larkSecrets, call)
		const failure = yield* Effect.flip(
			channel.send(
				Target.Conversation({ conversation: "oc_1" }),
				{
					markdown: "hello",
				},
				"message-key",
			),
		)
		assert.strictEqual(failure.retry, false)
		assert.strictEqual(
			failure.message,
			"Lark did not give a tenant token: invalid param",
		)
	}).pipe(Effect.provide(NodeCrypto.layer)),
)

it.effect("A custom Channel says what is wrong with a body or an answer", () =>
	Effect.gen(function* () {
		const secret = "custom-secret"
		const answer = yield* Ref.make<unknown>({})
		const call: Http.Call = () =>
			Effect.map(Ref.get(answer), (json) => ({
				status: 200,
				headers: {},
				json,
			}))
		const channel = CustomChannel.make(
			{
				endpoint: "https://custom.example.com/hook",
				secret: Redacted.make(secret),
			},
			call,
		)
		const now = 1_700_000_000_000
		const timestamp = String(now / 1000)
		const body = '{"type":"message","id":"e1"}'
		const denied = yield* Effect.flip(
			channel.receive({
				headers: {
					"x-openbot-timestamp": timestamp,
					"x-openbot-signature":
						"sha256=" + hmacHex(secret, `${timestamp}.${body}`),
				},
				body,
				now,
			}),
		)
		assert.match(
			denied.reason,
			/^the body is not a CustomEvent: .*conversation/s,
		)
		const failure = yield* Effect.flip(
			channel.send(
				Target.Conversation({ conversation: "room-1" }),
				{
					markdown: "hello",
				},
				"message-key",
			),
		)
		assert.strictEqual(failure.retry, false)
		assert.match(
			failure.message,
			/^The custom Channel did not answer with a ref: .*ref/s,
		)
	}),
)
