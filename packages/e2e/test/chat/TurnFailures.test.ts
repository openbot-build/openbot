import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { HostTools } from "@openbot-build/openbot"
import {
	BrowserHost,
	Caller,
	Failures,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { Array as Arr, Deferred, Effect, Option, Stream } from "effect"
import { LanguageModel, type Prompt } from "effect/ai"

// The test uses real storage and waits for the execution's saved final state.
it.live(
	"saved Turn failures keep one error record through updates and cancellation",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const failsOrWaits = (prompt: Prompt.Prompt) =>
				Arr.some(
					prompt.content,
					(message) =>
						message.role === "user" &&
						(typeof message.content === "string"
							? message.content === "Cancel"
							: Arr.some(
									message.content,
									(part) => part.type === "text" && part.text === "Cancel",
								)),
				)
			const model = yield* LanguageModel.make({
				generateText: () => Effect.die("This test uses streams."),
				streamText: ({ prompt }) =>
					failsOrWaits(prompt)
						? Stream.unwrap(
								Deferred.succeed(started, undefined).pipe(
									Effect.as(Stream.never),
								),
							)
						: Stream.die(new Error("Model unavailable")),
			})
			const publicOrigin = "https://error-records.example.com"
			const host = yield* BrowserHost.start({
				publicOrigin,
				model,
				hostTools: HostTools.none,
			})
			const member = yield* host.login("error-records")
			const bot = yield* host.defaultBot(member.session)
			const send: Messages.Send = (path, method, body) =>
				Effect.flatMap(host.address, (address) =>
					Caller.withCookie({ address, publicOrigin })(
						member.session,
						path,
						method,
						body,
					),
				)
			const { receipt, view: failed } = yield* Messages.talk(
				send,
				bot,
				"Private input",
			)
			assert.strictEqual(failed.response?.status, "failed")
			const read = host.run(Failures.read)
			const saved = yield* read
			assert.strictEqual(saved.length, 1)
			assert.strictEqual(saved[0]?.executionId, receipt.executionId)
			const record = yield* Caller.read(
				Execution.Record,
				send(`/v1/executions/${receipt.executionId}`, "GET"),
			)
			assert.strictEqual(record.failure?.errorId, saved[0]?.id)
			assert.strictEqual(
				(yield* send(`/v1/chats/${receipt.chat}`, "PATCH", {
					expected: failed.chat.revision,
					mode: "plan",
				})).status,
				200,
			)
			assert.deepStrictEqual(yield* read, saved)
			const pending = yield* Messages.send(send, receipt.chat, "Cancel")
			yield* Deferred.await(started)
			const stop = yield* Caller.read(
				Execution.Receipt,
				send(`/v1/chats/${receipt.chat}/interrupt`, "POST", {
					commandKey: "stop",
				}),
				202,
			)
			yield* Wait.until(
				"the cancelled execution",
				Caller.read(
					Execution.Record,
					send(`/v1/executions/${stop.executionId}`, "GET"),
				).pipe(
					Effect.map((record) =>
						Execution.isTerminal(record.status)
							? Option.some(record)
							: Option.none(),
					),
				),
			)
			const cancelled = yield* Messages.view(send, receipt.chat)
			assert.strictEqual(cancelled.response?.id, pending.turn)
			assert.strictEqual(cancelled.response?.status, "cancelled")
			assert.deepStrictEqual(yield* read, saved)
		}).pipe(Effect.provide(BrowserHost.layerPlatform)),
)
