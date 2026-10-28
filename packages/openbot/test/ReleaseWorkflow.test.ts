import { assert, layer } from "@effect/vitest"
import {
	ChatCommandReceipt,
	ExecutionsApi,
	TriggersApi,
} from "@openbot-build/api"
import { Array as Arr, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as Release from "../src/release/Admission.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Wait from "./Wait.ts"

const tasks = Schema.Array(
	Schema.Struct({
		chat: Schema.Struct({ id: Schema.String }),
		status: Schema.String,
	}),
)
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "120 seconds",
})((it) => {
	it.effect(
		"release lets an accepted answer finish and keeps an expired timer through a server restart",
		() =>
			Effect.gen(function* () {
				const token = "release-workflow-test-token-at-least-32-characters"
				const publicOrigin = "https://release.example.test"
				const host = yield* BrowserHost.start({
					publicOrigin,
					internalToken: token,
					bots: { memory: false },
				})
				const account = yield* host.login("release-owner")
				const bot = yield* host.defaultBot(account.session)
				const request: Messages.Send = (path, method, payload) =>
					host.address.pipe(
						Effect.flatMap((address) =>
							Caller.withCookie({ address, publicOrigin })(
								account.session,
								path,
								method,
								payload,
							),
						),
					)
				const control = (name: string) =>
					host.address.pipe(
						Effect.flatMap((address) =>
							HttpClientRequest.post(address + "/internal/execution/" + name, {
								headers: { authorization: `Bearer ${token}` },
							}).pipe(
								HttpClient.execute,
								Effect.flatMap(Caller.json(Release.Status)),
							),
						),
					)
				yield* Effect.gen(function* () {
					const receipt = yield* request(`/v1/bots/${bot}/messages`, "POST", {
						input: "slow answer",
						commandKey: "release-slow-answer",
					}).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
					const paused = yield* control("quiesce")
					assert.isTrue(paused.quiesced)
					assert.isFalse(paused.drained)
					assert.equal(
						(yield* request(`/v1/bots/${bot}/messages`, "POST", {
							input: "must not start",
							commandKey: "release-denied-answer",
						})).status,
						503,
					)
					yield* Wait.untilTrue(
						"accepted answer after quiesce",
						request(`/v1/executions/${receipt.executionId}`, "GET").pipe(
							Effect.flatMap(Caller.json(ExecutionsApi.Execution.Record)),
						),
						(value) => value.status === "completed",
						{ spacing: "100 millis", times: 200 },
					)
					yield* Wait.untilTrue(
						"empty runtime after the answer",
						control("status"),
						(value) => value.drained,
						{ spacing: "100 millis", times: 150 },
					)
					yield* control("resume")
					const trigger = yield* request("/v1/triggers", "POST", {
						bot,
						prompt: "Review the saved timer once it is due.",
						schedule: { cron: "* * * * * *", timeZone: "UTC" },
					}).pipe(Effect.flatMap(Caller.json(TriggersApi.Trigger, 201)))
					yield* control("quiesce")
					const readTasks = request("/v1/chats?kind=task", "GET").pipe(
						Effect.flatMap(Caller.json(tasks)),
					)
					const before = yield* readTasks
					yield* Effect.sleep("1500 millis")
					assert.deepEqual(
						yield* readTasks,
						before,
						"An expired timer cannot start new work during release.",
					)
					yield* Wait.untilTrue(
						"idle schedule is safe to stop",
						control("status"),
						(value) => value.drained,
						{ spacing: "100 millis", times: 150 },
					)
					yield* host.restart
					assert.isTrue((yield* control("status")).quiesced)
					assert.deepEqual(yield* readTasks, before)
					yield* control("resume")
					const after = yield* Wait.untilTrue(
						"saved timer after resume",
						readTasks,
						(value) => value.length > before.length,
						{ spacing: "100 millis", times: 200 },
					)
					const latest = yield* request(
						`/v1/triggers/${trigger.id}`,
						"GET",
					).pipe(Effect.flatMap(Caller.json(TriggersApi.Trigger)))
					yield* request(`/v1/triggers/${trigger.id}`, "PATCH", {
						expected: latest.revision,
						enabled: false,
					}).pipe(Effect.flatMap(Caller.json(TriggersApi.Trigger)))
					const taskIds = Arr.map(after, (entry) => entry.chat.id)
					yield* Wait.untilTrue(
						"saved trigger task result",
						readTasks,
						(value) =>
							Arr.every(taskIds, (id) =>
								Arr.some(
									value,
									(task) => task.chat.id === id && task.status === "Completed",
								),
							),
						{ spacing: "100 millis", times: 200 },
					)
				}).pipe(
					Effect.ensuring(control("resume").pipe(Effect.orDie, Effect.asVoid)),
				)
			}),
		{ timeout: 120000 },
	)
})
