import { assert, layer } from "@effect/vitest"
import { BotsApi, ChannelsApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Option,
	Ref,
	Schema,
	String as Str,
} from "effect"
import {
	BrowserHost,
	Caller,
	ChannelScenarios,
	Wait,
} from "@openbot-build/openbot/testing"

const { until } = Wait

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"an unknown Channel send stays paused after restart and retries only after a saved decision",
		() =>
			Effect.gen(function* () {
				const sends = yield* Ref.make(0)
				const fail = yield* Ref.make(true)
				const keys = yield* Ref.make<ReadonlyArray<string>>([])
				const publicOrigin = "https://channel-recovery.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformFetch: (request) =>
						Effect.gen(function* () {
							if (Str.endsWith("/tenant_access_token/internal")(request.url))
								return Response.json({
									code: 0,
									tenant_access_token: "tenant-token",
									expire: 7200,
								})
							const body = yield* Effect.promise(() => request.text())
							const { uuid } = yield* Schema.decodeEffect(
								Schema.fromJsonString(Schema.Struct({ uuid: Schema.String })),
							)(body).pipe(Effect.orDie)
							yield* Ref.update(keys, Arr.append(uuid))
							yield* Ref.update(sends, (count) => count + 1)
							return (yield* Ref.get(fail))
								? new Response("No result", { status: 500 })
								: Response.json({
										code: 0,
										data: { chat_id: "room", message_id: "message" },
									})
						}),
				})
				const alice = yield* host.login("channel-recovery")
				const send = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const bot = yield* Caller.read(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Team",
						role: "Helps people",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const channel = yield* Caller.read(
					ChannelsApi.Channel,
					send(alice.session, "/v1/organization/channels", "POST", {
						commandKey: "channel-recovery",
						name: "Team",
						bot: bot.id,
						credentials: {
							kind: "lark",
							domain: "feishu",
							appId: "app",
							appSecret: "test-secret",
							verificationToken: "test-token",
							encryptKey: "test-key",
						},
					}),
				)
				yield* host.run(
					ChannelScenarios.receiveMessage(
						alice.identity.organizationId,
						channel.id,
						{
							eventId: "event-1",
							conversation: { key: "room", kind: "direct" },
							sender: { externalId: "person", displayName: "Person" },
							text: "Hello",
							mentioned: false,
						},
					),
				)
				const read = host.run(
					ChannelScenarios.delivery(alice.identity.organizationId),
				)
				const paused = yield* until(
					"the unknown Channel send",
					read.pipe(
						Effect.map(
							Option.filter((row) => row.status === "outcome_unknown"),
						),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 1)
				const key = {
					namespace: paused.namespace,
					id: Execution.Id.make(paused.id),
				}
				yield* host.restart
				yield* until(
					"the restored Channel owner",
					read.pipe(
						Effect.map(
							Option.filter(
								(row) =>
									row.generation > paused.generation &&
									row.status === "outcome_unknown",
							),
						),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 1)
				const events = yield* host.run(
					ChannelScenarios.events(alice.identity.organizationId, key.id),
				)
				const decision = Arr.findFirst(
					events,
					(event) => event.body._tag === "DecisionNeeded",
				)
				assert.ok(
					Option.isSome(decision) &&
						decision.value.body._tag === "DecisionNeeded",
				)
				yield* Ref.set(fail, false)
				const current = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const body = {
					commandKey: "retry-channel-send",
					decisionId: decision.value.body.decisionId,
					answer: "retry",
				}
				const receipt = yield* Caller.read(
					Execution.Receipt,
					current(
						alice.session,
						"/v1/executions/" + key.id + "/decisions",
						"POST",
						body,
					),
					200,
				)
				assert.strictEqual(receipt.executionId, key.id)
				yield* until(
					"the Channel send to end",
					read.pipe(
						Effect.map(Option.filter((row) => row.status === "completed")),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 2)
				const sentKeys = yield* Ref.get(keys)
				assert.strictEqual(sentKeys.length, 2)
				assert.strictEqual(sentKeys[0], sentKeys[1])
				assert.match(sentKeys[0]!, /^[A-Za-z0-9_-]{43}$/)
				assert.deepStrictEqual(
					yield* Caller.read(
						Execution.Receipt,
						current(
							alice.session,
							"/v1/executions/" + key.id + "/decisions",
							"POST",
							body,
						),
						200,
					),
					receipt,
				)
				const calls = yield* host.run(
					ChannelScenarios.calls(alice.identity.organizationId, key.id),
				)
				assert.deepStrictEqual(
					Arr.map(calls, (call) => [call.attempt, call.status]),
					[
						[0, "outcome_unknown"],
						[1, "completed"],
					],
				)
			}),
		90000,
	)
})
