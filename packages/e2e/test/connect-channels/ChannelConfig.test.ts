import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { BotsApi, ChannelsApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Option,
	Redacted,
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
const publicOrigin = "https://channel-config.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a known Channel refusal waits through restart before one new attempt",
		() =>
			Effect.gen(function* () {
				const sends = yield* Ref.make(0)
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformFetch: () =>
						Ref.updateAndGet(sends, (n) => n + 1).pipe(
							Effect.map((n) =>
								n === 1
									? Response.json(
											{ ok: false, parameters: { retry_after: 4 } },
											{ status: 429 },
										)
									: Response.json({ ok: true, result: true }),
							),
						),
				})
				const alice = yield* host.login("channel-retry")
				const send = (
					path: string,
					method: "GET" | "POST" = "GET",
					body?: unknown,
				) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							alice.session,
							path,
							method,
							body,
						),
					)
				const bot = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots", "POST", {
						name: "Team",
						role: "Helps people",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const channel = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels", "POST", {
						commandKey: "retry-config",
						name: "Team",
						bot: bot.id,
						credentials: { kind: "telegram", botToken: "123:retry-secret" },
					}),
					201,
				)
				assert.ok(channel.executionId)
				const id = channel.executionId
				const calls = host.run(
					ChannelScenarios.calls(alice.identity.organizationId, id),
				)
				yield* until(
					"the saved refusal",
					calls.pipe(
						Effect.map((rows) =>
							Arr.findFirst(rows, (row) => row.status === "completed"),
						),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 1)
				yield* host.restart
				yield* until(
					"the saved Channel retry",
					Caller.read(Execution.Record, send("/v1/executions/" + id)).pipe(
						Effect.map((record) =>
							record.status === "completed"
								? Option.some(record)
								: Option.none(),
						),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 2)
				assert.deepEqual(
					Arr.map(yield* calls, (call) => [call.attempt, call.status]),
					[
						[0, "completed"],
						[1, "completed"],
					],
				)
			}),
		60000,
	)

	it.effect(
		"Channel configuration waits for an unknown prior call across restart",
		() =>
			Effect.gen(function* () {
				const sends = yield* Ref.make(0)
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformFetch: () =>
						Ref.updateAndGet(sends, (n) => n + 1).pipe(
							Effect.map((n) =>
								n === 1
									? Response.json({ ok: false }, { status: 502 })
									: Response.json({ ok: true, result: true }),
							),
						),
				})
				const alice = yield* host.login("channel-config")
				const send = (
					path: string,
					method: "GET" | "POST" | "PATCH" = "GET",
					body?: unknown,
				) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							alice.session,
							path,
							method,
							body,
						),
					)
				const bot = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots", "POST", {
						name: "Team",
						role: "Helps people",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const input = {
					commandKey: "create-config",
					name: "Team",
					bot: bot.id,
					credentials: { kind: "telegram", botToken: "123:config-test-secret" },
				}
				const created = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels", "POST", input),
					201,
				)
				assert.ok(created.executionId)
				const state = (id: Execution.Id, status: Execution.Status) =>
					until(
						"the configuration state",
						Caller.read(Execution.Record, send("/v1/executions/" + id)).pipe(
							Effect.map((record) =>
								record.status === status ? Option.some(record) : Option.none(),
							),
						),
					)
				yield* state(created.executionId, "outcome_unknown")
				const changed = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels/" + created.id, "PATCH", {
						commandKey: "change-config",
						expectedVersion: created.version,
						name: "New team",
					}),
				)
				assert.ok(changed.executionId)
				yield* state(changed.executionId, "running")
				assert.strictEqual(yield* Ref.get(sends), 1)
				const generation = yield* host.run(
					ChannelScenarios.generation(
						alice.identity.organizationId,
						created.executionId!,
					),
				)
				yield* host.restart
				yield* until(
					"the configuration owner returns",
					host.run(
						ChannelScenarios.generation(
							alice.identity.organizationId,
							created.executionId!,
						).pipe(
							Effect.map((current) =>
								current > generation ? Option.some(current) : Option.none(),
							),
						),
					),
				)
				assert.strictEqual(yield* Ref.get(sends), 1)
				const events = yield* host.run(
					ChannelScenarios.events(
						alice.identity.organizationId,
						created.executionId!,
					),
				)
				const needed = Arr.findLast(
					events,
					(event) => event.body._tag === "DecisionNeeded",
				)
				assert.ok(
					Option.isSome(needed) && needed.value.body._tag === "DecisionNeeded",
				)
				yield* Caller.read(
					Execution.Receipt,
					send("/v1/executions/" + created.executionId + "/decisions", "POST", {
						commandKey: "stop-old-config",
						decisionId: needed.value.body.decisionId,
						answer: "stop",
					}),
				)
				yield* state(created.executionId, "interrupted")
				yield* state(changed.executionId, "completed")
				assert.strictEqual(yield* Ref.get(sends), 2)
				assert.deepStrictEqual(
					yield* Caller.read(
						ChannelsApi.Channel,
						send("/v1/organization/channels", "POST", input),
						201,
					),
					created,
				)
				const current = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels/" + created.id),
				)
				assert.strictEqual(current.name, "New team")
				assert.strictEqual(current.executionId, changed.executionId)
				assert.strictEqual(yield* Ref.get(sends), 2)
				const raw = yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						return yield* sql<{
							payload: string | null
						}>`select payload from openbot_cluster_messages`
					}),
				)
				assert.ok(
					Arr.every(
						raw,
						(row) =>
							row.payload === null ||
							!Str.includes("config-test-secret")(row.payload),
					),
				)
			}),
		90000,
	)

	it.effect(
		"a secret command returns its saved secret after concurrent retries and restart",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("channel-secret")
				const send = (
					path: string,
					method: "GET" | "POST" | "PUT" = "GET",
					body?: unknown,
				) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							alice.session,
							path,
							method,
							body,
						),
					)
				const bot = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots", "POST", {
						name: "Team",
						role: "Helps people",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const created = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels", "POST", {
						commandKey: "create-custom",
						name: "Team",
						bot: bot.id,
						credentials: {
							kind: "custom",
							endpoint: "https://channel.example.com/hook",
						},
					}),
					201,
				)
				const command = {
					commandKey: "one-secret",
					expectedVersion: created.version,
				}
				const rotate = Caller.read(
					ChannelsApi.ChannelSecret,
					send(
						"/v1/organization/channels/" + created.id + "/secret",
						"PUT",
						command,
					),
				)
				const [first, second] = yield* Effect.all([rotate, rotate], {
					concurrency: "unbounded",
				})
				assert.strictEqual(
					Redacted.value(first.secret),
					Redacted.value(second.secret),
				)
				assert.deepStrictEqual(first.channel, second.channel)
				assert.strictEqual(first.channel.version, created.version + 1)
				yield* host.restart
				const restored = yield* rotate
				assert.strictEqual(
					Redacted.value(first.secret),
					Redacted.value(restored.secret),
				)
				assert.deepStrictEqual(first.channel, restored.channel)
				const conflict = yield* Caller.read(
					Execution.KeyConflict,
					send("/v1/organization/channels/" + created.id + "/secret", "PUT", {
						...command,
						expectedVersion: first.channel.version,
					}),
					409,
				)
				assert.strictEqual(conflict._tag, "ExecutionKeyConflict")
				const current = yield* Caller.read(
					ChannelsApi.Channel,
					send("/v1/organization/channels/" + created.id),
				)
				assert.strictEqual(current.version, first.channel.version)
				const json = yield* Schema.encodeEffect(
					Schema.fromJsonString(ChannelsApi.Channel),
				)(current)
				assert.ok(!Str.includes(Redacted.value(first.secret))(json))
			}),
		60000,
	)
})
