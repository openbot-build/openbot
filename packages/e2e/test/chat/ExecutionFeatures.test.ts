import { assert, layer } from "@effect/vitest"
import {
	ChatCommandReceipt,
	ChatSummary,
	DelegationsApi,
	ExecutionsApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	BrowserHost,
	Caller,
	Messages,
	Workflow,
} from "@openbot-build/openbot/testing"
import { Array as Arr, Effect, Option, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)
const textOf = (message: Prompt.UserMessage) =>
	typeof message.content === "string"
		? message.content
		: Arr.join(
				Arr.flatMap(message.content, (part) =>
					part.type === "text" ? [part.text] : [],
				),
				"",
			)

/** Waits for the public event stream to end before reading the final state. */
const completed = (send: Messages.Send, id: Execution.Id) =>
	Effect.gen(function* () {
		const response = yield* send(`/v1/executions/${id}/observe`, "GET")
		assert.equal(response.status, 200)
		yield* response.text
		return yield* Caller.read(
			Execution.Record,
			send(`/v1/executions/${id}`, "GET"),
		)
	}).pipe(Effect.timeout("20 seconds"))

const events = (send: Messages.Send, id: Execution.Id) =>
	Caller.read(
		ExecutionsApi.EventPage,
		send(`/v1/executions/${id}/events`, "GET"),
	)

layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"the server runs a task and returns its notice through registered workflows",
		() =>
			Effect.gen(function* () {
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses a stream."),
					streamText: ({ prompt }) => {
						const input = Option.map(
							Arr.findLast(
								prompt.content,
								(message): message is Prompt.UserMessage =>
									message.role === "user",
							),
							textOf,
						)
						if (
							Option.contains(input, "Start the task") &&
							!Arr.some(prompt.content, (message) => message.role === "tool")
						)
							return Stream.make(
								Response.makePart("tool-call", {
									id: "delegate",
									name: "openbot_delegate",
									params: {
										task: "Read the shared note",
										limits: { timeMs: 60000 },
									},
									providerExecuted: false,
								}),
								Response.makePart("finish", { reason: "tool-calls", usage }),
							)
						return answer(
							Option.contains(input, "Read the shared note")
								? "The task is done"
								: "I read the result",
						)
					},
				})
				const host = yield* BrowserHost.start({
					publicOrigin: "https://workflow-features.example.com",
					model,
				})
				const member = yield* host.login("workflow-features-member")
				const bot = yield* host.defaultBot(member.session)
				const address = yield* host.address
				const send: Messages.Send = (path, method, payload) =>
					Caller.withCookie({
						address,
						publicOrigin: "https://workflow-features.example.com",
					})(member.session, path, method, payload)
				const receipt = yield* Caller.read(
					ChatCommandReceipt,
					send(`/v1/bots/${bot}/messages`, "POST", {
						commandKey: "task-input",
						input: "Start the task",
					}),
					202,
				)
				assert.equal(
					(yield* completed(send, receipt.executionId)).status,
					"completed",
				)
				const toolEvent = Option.getOrThrow(
					Arr.findFirst(
						(yield* events(send, receipt.executionId)).events,
						(event) => event.body._tag === "ChildExecution",
					),
				)
				if (toolEvent.body._tag !== "ChildExecution")
					return assert.fail("Expected a tool execution")
				const delegationEvent = Option.getOrThrow(
					Arr.findFirst(
						(yield* events(send, toolEvent.body.executionId)).events,
						(event) => event.body._tag === "ChildExecution",
					),
				)
				if (delegationEvent.body._tag !== "ChildExecution")
					return assert.fail("Expected a delegation execution")
				const delegationId = delegationEvent.body.executionId
				const execution = yield* completed(send, delegationId)
				assert.equal(execution.status, "completed")
				const delegation = yield* Caller.read(
					DelegationsApi.Delegation,
					send(`/v1/delegations/${execution.resource.id}`, "GET"),
				)
				assert.equal(delegation.result, "The task is done")
				if (delegation.chat === null) return assert.fail("The task has no Chat")
				const snapshot = yield* Messages.view(send, delegation.chat)
				assert.ok(snapshot.executionId !== null)
				if (snapshot.executionId === null)
					return assert.fail("The task Turn has no execution")
				assert.strictEqual(
					(yield* Caller.read(
						Execution.Record,
						send(`/v1/executions/${snapshot.executionId}`, "GET"),
					)).resource.id,
					snapshot.turn?.id,
				)
				const tasks = yield* Caller.read(
					Schema.Array(ChatSummary),
					send("/v1/chats?kind=task", "GET"),
				)
				assert.ok(
					Arr.some(
						tasks,
						(entry) =>
							entry.chat.id === snapshot.chat.id &&
							entry.executionId === snapshot.executionId,
					),
				)
				const notice = Option.getOrThrow(
					yield* Workflow.delegationNoticeReceipt(
						host,
						member.identity,
						delegationId,
						"The task is done",
					),
				)
				assert.equal(
					(yield* completed(send, notice.executionId)).status,
					"completed",
				)
				const { items } = yield* Caller.read(
					Schema.Struct({ items: Schema.Array(Item.Record) }),
					send(`/v1/chats/${delegation.parent.chat}/items?limit=100`, "GET"),
				)
				assert.equal(
					Arr.filter(
						items,
						(item) =>
							item.origin?.notice?.kind === "delegation" &&
							item.origin.notice.ref === delegation.id,
					).length,
					1,
				)
				assert.ok(
					Arr.some(
						(yield* events(send, delegationId)).events,
						(event) => event.body._tag === "ChildExecution",
					),
				)
			}),
	)
})
