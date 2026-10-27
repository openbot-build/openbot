import {
	BrowserHost,
	Caller,
	Messages,
	Policies,
	Wait,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	Authorization,
	DelegationsApi,
	ExecutionsApi,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, pipe, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"

const { untilTrue } = Wait

const publicOrigin = "https://workflow-api.example.com"

const status = (call: Caller.Call, expected: number) =>
	Effect.gen(function* () {
		const response = yield* call
		assert.strictEqual(response.status, expected, yield* response.text)
	})

/** Gives each account both ways to call the real HTTP server. */
const clients = Effect.fn("WorkflowApiE2E.clients")(function* (
	host: BrowserHost.Host,
) {
	const alice = yield* host.login("workflow-alice")
	const bob = yield* host.login("workflow-bob")
	const address = yield* host.address
	const cookie =
		(session: typeof alice.session): Messages.Send =>
		(path, method, payload) =>
			Caller.withCookie({ address, publicOrigin })(
				session,
				path,
				method,
				payload,
			)
	const token =
		(secret: UserTokensApi.CreatedToken["secret"]): Messages.Send =>
		(path, method, payload) =>
			Caller.withToken(address)(secret, path, method, payload)
	const account = cookie(alice.session)
	const stranger = cookie(bob.session)
	const key = yield* Caller.read(
		UserTokensApi.CreatedToken,
		account("/v1/user/tokens", "POST", { name: "Workflow test" }),
		201,
	)
	const otherKey = yield* Caller.read(
		UserTokensApi.CreatedToken,
		stranger("/v1/user/tokens", "POST", { name: "Workflow test" }),
		201,
	)
	const readOnly = yield* Caller.read(
		UserTokensApi.CreatedToken,
		account("/v1/user/tokens", "POST", {
			name: "Read Chats",
			policy: yield* Policies.json(function* (_) {
				yield* _.allow("read", Authorization.Chat)
			}),
		}),
		201,
	)
	return {
		owners: [account, token(key.secret)],
		strangers: [stranger, token(otherKey.secret)],
		readOnly: token(readOnly.secret),
	}
})

const requestList = (send: Messages.Send, state: RequestsApi.RequestStatus) =>
	Caller.read(
		Schema.Array(RequestsApi.CapabilityRequest),
		send("/v1/requests?status=" + state, "GET"),
	)

const notices = (
	send: Messages.Send,
	chat: string,
	request: string,
	kind = "request",
) =>
	Caller.read(
		Schema.Struct({ items: Schema.Array(Item.Record) }),
		send(`/v1/chats/${chat}/items?limit=100`, "GET"),
	).pipe(
		Effect.map(({ items }) =>
			Arr.filter(
				items,
				(item) =>
					item.origin?.notice?.kind === kind &&
					item.origin.notice.ref === request &&
					Arr.some(item.content.content, (message) => message.role === "user"),
			),
		),
	)

const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: pipe(
				message.content,
				Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				Arr.join(""),
			)

/** The model starts real work that waits until the caller cancels it. */
const delegationModel = LanguageModel.make({
	generateText: () =>
		Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
	streamText: ({ prompt }) =>
		Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
			const last = Arr.findLastIndex(
				prompt.content,
				(message) => message.role === "user",
			)
			const index = Option.getOrElse(last, () => -1)
			const message = Arr.get(prompt.content, index)
			const input = Option.match(message, { onNone: () => "", onSome: textOf })
			if (input === "Wait for a cancel.") return Stream.fromEffect(Effect.never)
			const answered = Arr.some(
				Arr.drop(prompt.content, index + 1),
				(message) => message.role === "tool",
			)
			if (input === "Give work to yourself." && !answered)
				return Stream.make(
					Response.makePart("tool-call", {
						id: "delegate-call",
						name: "openbot_delegate",
						params: { task: "Wait for a cancel.", limits: { timeMs: 3600000 } },
						providerExecuted: false,
					}),
					Response.makePart("finish", { reason: "tool-calls", usage }),
				)
			return Stream.make(
				Response.makePart("text-start", { id: "answer" }),
				Response.makePart("text-delta", {
					id: "answer",
					delta: "The work is noted.",
				}),
				Response.makePart("text-end", { id: "answer" }),
				Response.makePart("finish", { reason: "stop", usage }),
			)
		}),
})

// HTTP servers and PostgreSQL use real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"cookies and tokens give the same request decisions, owner checks and command retries",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const { owners, strangers, readOnly } = yield* clients(host)
				for (const [send, index] of Arr.map(
					owners,
					(send, index) => [send, index] as const,
				)) {
					for (const decision of ["deny", "allow"] as const) {
						const bot = yield* Messages.bot(send)
						const first = yield* Messages.message(send, bot, "Ask for approval")
						// The row is visible before its workflow starts waiting.
						const pending = yield* untilTrue(
							"the tool asks for a decision",
							requestList(send, "pending"),
							(list) =>
								Arr.some(
									list,
									(request) =>
										request.chat === first.chat &&
										request.executionStatus === "waiting",
								),
						)
						const found = Arr.findFirst(
							pending,
							(request) =>
								request.chat === first.chat &&
								request.executionStatus === "waiting",
						)
						assert.ok(Option.isSome(found))
						const request = found.value
						const path = "/v1/requests/" + request.id
						const input = {
							commandKey: `answer-${index}-${decision}`,
							expected: request.revision,
							decision,
							reason:
								decision === "allow" ? "Do the work." : "Do not do the work.",
						}
						const before = yield* host.toolCalls
						const waiting = yield* Messages.settled(send, first.chat)
						assert.strictEqual(waiting.open.requests, 1)
						assert.strictEqual(request.capability.action, "tools.call")
						for (const owner of owners)
							assert.deepStrictEqual(
								yield* Caller.read(
									RequestsApi.CapabilityRequest,
									owner(path, "GET"),
								),
								request,
							)
						for (const stranger of strangers) {
							yield* status(stranger(path, "GET"), 404)
							yield* status(stranger(path, "POST", input), 404)
							assert.deepStrictEqual(
								yield* requestList(stranger, "pending"),
								[],
							)
						}
						yield* status(readOnly("/v1/requests", "GET"), 403)
						yield* status(readOnly(path, "GET"), 403)
						yield* status(readOnly(path, "POST", input), 403)
						yield* status(
							send(path, "POST", { ...input, expected: request.revision + 1 }),
							409,
						)
						const receipt = yield* Caller.read(
							Execution.Receipt,
							send(path, "POST", input),
							202,
						)
						assert.strictEqual(receipt.executionId, request.executionId)
						const state = decision === "allow" ? "allowed" : "denied"
						const resolved = yield* untilTrue(
							"the request has the decision",
							Caller.read(RequestsApi.CapabilityRequest, send(path, "GET")),
							(request) => request.status === state,
						)
						assert.strictEqual(resolved.decision?.reason, input.reason)
						yield* untilTrue(
							"the Chat has one decision notice",
							notices(send, first.chat, request.id),
							(items) => items.length === 1,
						)
						if (decision === "allow")
							yield* untilTrue(
								"the allowed tool ran once",
								host.toolCalls,
								(count) => count === before + 1,
							)
						assert.deepStrictEqual(
							yield* Caller.read(
								Execution.Receipt,
								send(path, "POST", input),
								202,
							),
							receipt,
						)
						for (const owner of owners) {
							assert.ok(
								Arr.some(
									yield* requestList(owner, state),
									(entry) => entry.id === request.id,
								),
							)
							// A command key also keeps the token of its first caller.
							if (owner !== send) yield* status(owner(path, "POST", input), 409)
						}
						yield* status(
							send(path, "POST", { ...input, reason: "A different answer." }),
							409,
						)
						yield* status(
							send(path, "POST", {
								...input,
								commandKey: input.commandKey + "-new",
								expected: resolved.revision,
							}),
							409,
						)
						const done = yield* Messages.settled(send, first.chat)
						assert.strictEqual(done.open.requests, 0)
						assert.strictEqual(
							yield* host.toolCalls,
							before + (decision === "allow" ? 1 : 0),
						)
						assert.strictEqual(
							(yield* notices(send, first.chat, request.id)).length,
							1,
						)
					}
				}
			}),
	)
	it.effect(
		"cookies and tokens read and cancel delegated work with the same policy and retry rules",
		() =>
			Effect.gen(function* () {
				const model = yield* delegationModel
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const { owners, strangers, readOnly } = yield* clients(host)
				for (const [send, index] of Arr.map(
					owners,
					(send, index) => [send, index] as const,
				)) {
					const bot = yield* Messages.bot(send)
					const first = yield* Messages.message(
						send,
						bot,
						"Give work to yourself.",
					)
					yield* Messages.settled(send, first.chat)
					const listPath = `/v1/chats/${first.chat}/delegations`
					const list = yield* untilTrue(
						"the Bot has running work",
						Caller.read(
							Schema.Array(DelegationsApi.Delegation),
							send(listPath, "GET"),
						),
						(list) =>
							list.length === 1 &&
							list[0]?.status === "running" &&
							list[0]?.chat !== null,
					)
					const work = list[0]!
					assert.ok(work.chat !== null)
					const child = work.chat
					yield* untilTrue(
						"the child Chat runs",
						Messages.view(send, child),
						(view) => view.status === "Running",
					)
					const path = "/v1/delegations/" + work.id
					const cancel = path + "/cancel"
					const input = { commandKey: "stop-work-" + index }
					for (const owner of owners) {
						const read = yield* Caller.read(
							DelegationsApi.Delegation,
							owner(path, "GET"),
						)
						assert.strictEqual(read.id, work.id)
						assert.strictEqual(read.status, "running")
						assert.strictEqual(read.executionId, work.executionId)
					}
					for (const stranger of strangers) {
						yield* status(stranger(path, "GET"), 404)
						yield* status(stranger(listPath, "GET"), 404)
						yield* status(stranger(cancel, "POST", input), 404)
					}
					yield* status(readOnly(path, "GET"), 200)
					yield* status(readOnly(cancel, "POST", input), 403)
					yield* status(send(cancel, "POST", { commandKey: "" }), 400)
					const receipt = yield* Caller.read(
						Execution.Receipt,
						send(cancel, "POST", input),
						202,
					)
					assert.strictEqual(receipt.executionId, work.executionId)
					const stopped = yield* untilTrue(
						"the work stops",
						Caller.read(DelegationsApi.Delegation, send(path, "GET")),
						(work) =>
							work.status === "cancelled" &&
							work.executionStatus === "cancelled",
					)
					assert.strictEqual(stopped.failure, null)
					const terminal = yield* untilTrue(
						"the work releases its resources",
						Caller.read(
							ExecutionsApi.EventPage,
							send(`/v1/executions/${work.executionId}/events`, "GET"),
						),
						(page) => page.terminal,
					)
					assert.ok(terminal.events.length > 0)
					assert.strictEqual(
						(yield* Messages.settled(send, child)).status,
						"Interrupted",
					)
					yield* untilTrue(
						"the parent has one notice of the stopped work",
						notices(send, first.chat, work.id, "delegation"),
						(items) => items.length === 1,
					)
					assert.deepStrictEqual(
						yield* Caller.read(
							Execution.Receipt,
							send(cancel, "POST", input),
							202,
						),
						receipt,
					)
					for (const owner of owners)
						if (owner !== send) yield* status(owner(cancel, "POST", input), 409)
					const done = yield* Messages.settled(send, first.chat)
					assert.strictEqual(done.open.delegations, 0)
					assert.strictEqual(
						(yield* notices(send, first.chat, work.id, "delegation")).length,
						1,
					)
				}
			}),
	)
})
