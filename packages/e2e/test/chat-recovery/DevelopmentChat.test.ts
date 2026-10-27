import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"

import { Config, Model } from "@openbot-build/core"
import * as Client from "@openbot-build/client"

import { ChatSummary, ChatView } from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	Layer,
	Schema,
	Scope,
	Stream,
} from "effect"

import { message, settled, sendMessage } from "../support/Development.ts"

import * as Development from "@openbot-build/openbot/Development"
import {
	Caller,
	PostgresTest,
	DefaultBot,
} from "@openbot-build/openbot/testing"
import {
	browser,
	signIn,
	settings,
	platform,
	ItemPage,
	toJson,
	migrate,
	launch,
	fetchWith,
	defaultModel,
	developmentProvider,
} from "../support/Development.ts"

// These journeys use real servers and the real clock.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"development assembly streams through the API and keeps the Chat after a restart",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const publicOrigin = options.auth.publicOrigin
				yield* migrate(options)
				// The first server has a scope of its own, so the test can stop it before the restart.
				const firstScope = yield* Scope.fork(yield* Effect.scope)
				const first = yield* Scope.provide(
					launch(Development.layer(options)),
					firstScope,
				)
				const { credential, cookie, send } = yield* signIn(
					first.address,
					publicOrigin,
				)
				const defaultBot = yield* DefaultBot.ensure(send)
				const receipt = yield* message(
					send,
					defaultBot,
					"Persist this development conversation",
				)
				const response = yield* send(
					`/v1/executions/${receipt.executionId}/observe`,
					"GET",
				)
				assert.strictEqual(response.status, 200)
				const events = yield* response.text
				assert.match(events, /"_tag":"Text"/)
				assert.match(
					events,
					/Development response: Persist this development conversation/,
				)
				assert.match(events, /"status":"completed"/)
				const [summary] = yield* Effect.flatMap(
					send(`/v1/chats?bot=${defaultBot}`, "GET"),
					Caller.json(Schema.Array(ChatSummary)),
				)
				assert.ok(summary !== undefined)
				const id = summary.chat.id
				const path = `/v1/chats/${id}`
				// The development platform gives each new Chat a simulated model.
				assert.deepStrictEqual(summary.chat.settings.model, defaultModel)
				const saved = yield* settled(send, id)
				assert.strictEqual(saved.status, "Completed")
				const savedItems = yield* Effect.flatMap(
					send(path + "/items", "GET"),
					Caller.json(ItemPage),
				)
				assert.ok(savedItems.items.length >= 2)
				yield* Scope.close(firstScope, Exit.void)
				const restarted = yield* launch(Development.layer(options))
				const restartedSend = browser(
					restarted.address,
					publicOrigin,
					credential,
				)
				const restored = yield* Effect.flatMap(
					restartedSend(path, "GET"),
					Caller.json(ChatView),
				)
				assert.deepStrictEqual(restored, saved)
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						restartedSend(path + "/items", "GET"),
						Caller.json(ItemPage),
					),
					savedItems,
				)
				const { api } = Context.get(
					yield* Layer.build(
						Client.layer({ baseUrl: restarted.address }).pipe(
							Layer.provide(fetchWith(cookie, publicOrigin)),
						),
					),
					Client.Client,
				)
				const observe = (executionId: typeof receipt.executionId) =>
					Stream.unwrap(
						api.executions.observe({ params: { executionId }, query: {} }),
					)
				const continuation = yield* sendMessage(
					restartedSend,
					id,
					"Continue once",
				)
				const continuedEvents = yield* observe(continuation.executionId).pipe(
					Stream.runCollect,
				)
				assert.match(
					yield* toJson(continuedEvents),
					/Development response: Continue once/,
				)
				const continued = yield* settled(restartedSend, id)
				assert.strictEqual(
					(yield* restartedSend(path + "/items", "GET").pipe(
						Effect.flatMap(Caller.json(ItemPage)),
					)).items.length,
					savedItems.items.length + 2,
				)
				const select = (current: ChatView, name: string) =>
					restartedSend(path, "PATCH", {
						expected: current.chat.revision,
						model: Config.Selection.make({
							provider: developmentProvider,
							model: Model.Id.make(name),
						}),
					}).pipe(Effect.flatMap(Caller.json(ChatView)))
				yield* select(continued, "mock-slow")
				const slow = yield* sendMessage(
					restartedSend,
					id,
					"Interrupt this slow response",
				)
				const partial = yield* observe(slow.executionId).pipe(
					Stream.filter((event) => event.data.body._tag === "Text"),
					Stream.take(1),
					Stream.runCollect,
				)
				assert.strictEqual(partial.length, 1)
				// Closing observation does not cancel the accepted Turn.
				const running = yield* api.executions.get({
					params: { executionId: slow.executionId },
				})
				assert.strictEqual(running.status, "running")
				yield* api.executions.cancel({
					params: { executionId: slow.executionId },
					payload: {
						commandKey: Execution.CommandKey.make(`cancel:${slow.executionId}`),
					},
				})
				yield* observe(slow.executionId).pipe(Stream.runDrain)
				const interrupted = yield* settled(restartedSend, id)
				assert.strictEqual(interrupted.status, "Interrupted")
				assert.strictEqual(interrupted.response?.status, "cancelled")
				yield* select(interrupted, "mock-failure")
				const failing = yield* sendMessage(
					restartedSend,
					id,
					"Save this failed input",
				)
				const failedEvents = yield* observe(failing.executionId).pipe(
					Stream.runCollect,
				)
				assert.ok(
					Arr.some(failedEvents, (event) => event.data.body._tag === "Text"),
				)
				assert.ok(
					Arr.some(
						failedEvents,
						(event) =>
							event.data.body._tag === "State" &&
							event.data.body.status === "failed",
					),
				)
				const failed = yield* settled(restartedSend, id)
				assert.strictEqual(failed.status, "Failed")
				assert.strictEqual(failed.response?.status, "failed")
				assert.match(
					yield* restartedSend(path + "/items", "GET").pipe(
						Effect.flatMap((response) => response.text),
					),
					/Save this failed input/,
				)
				yield* select(failed, defaultModel.model)
				const recovered = yield* sendMessage(
					restartedSend,
					id,
					"Recover after failure",
				)
				yield* observe(recovered.executionId).pipe(Stream.runDrain)
				assert.strictEqual(
					(yield* settled(restartedSend, id)).response?.status,
					"completed",
				)
			}),
		{ timeout: 30000 },
	)
})
