// @effect-diagnostics strictEffectProvide:off
import { PgClient } from "@effect/sql-pg"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	AppExecution,
	AuthApi,
	ChatView,
	RequestsApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Response, Tool } from "effect/ai"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { AppPlugin } from "../src/plugins/apps/AppPlugin.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { message, settled, type Send } from "./Messages.ts"

test("the OpenBot App plugin combines live paged capabilities with caller tools and records real handler results for the current account", async () => {
	const publisher = await Fixture.start({ capabilities: true })
	let observed: ReadonlyArray<{
		readonly input: string
		readonly descriptions: ReadonlyArray<string>
	}> = []
	const usage = {
		inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	}
	const model = await Effect.runPromise(
		LanguageModel.make({
			generateText: () =>
				Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
			streamText: ({ prompt, tools }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					const last = prompt.content.findLastIndex(
						(message) => message.role === "user",
					)
					const input = Match.value(prompt.content[last]).pipe(
						Match.when({ role: "user" }, (message) =>
							message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
						),
						Match.orElse(() => ""),
					)
					observed = Arr.append(observed, {
						input,
						descriptions: tools.map((tool) => tool.description ?? tool.name),
					})
					const result = prompt.content
						.slice(last + 1)
						.flatMap((message) =>
							Match.value(message).pipe(
								Match.when({ role: "tool" }, (message) =>
									message.content.filter((part) => part.type === "tool-result"),
								),
								Match.orElse(() => []),
							),
						)
						.at(-1)
					if (result !== undefined)
						return Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: JSON.stringify(result.result),
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						)
					// A message from OpenBot, such as a decision, asks for no new App call.
					if (input.startsWith("[OpenBot]"))
						return Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", { id: "answer", delta: input }),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						)
					const wanted = input.includes("ordinary")
						? "read_document"
						: input.includes("write")
							? "write_board"
							: input.includes("resource")
								? "notes://documents/index"
								: input.includes("template")
									? "notes://documents/{id}"
									: input.includes("prompt")
										? "review_document"
										: "read_later"
					const selected = tools.find(
						(tool) =>
							tool.description?.includes(
								(input.includes("write")
									? "Personal documents"
									: "Work documents") +
									" / " +
									wanted,
							) === true,
					)
					if (selected === undefined)
						return Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: "No matching App capability is available.",
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						)
					const priorDocument =
						prompt.content
							.flatMap((message) =>
								Match.value(message).pipe(
									Match.when({ role: "tool" }, (message) =>
										message.content
											.filter((part) => part.type === "tool-result")
											.flatMap((part) => {
												const value = Schema.decodeUnknownOption(
													AppExecution.Result,
												)(part.result)
												return Option.isSome(value) &&
													value.value._tag === "Completed"
													? [value.value.result]
													: []
											}),
									),
									Match.orElse(() => []),
								),
							)
							.flatMap((value) => {
								const document = Schema.decodeUnknownOption(
									Schema.Struct({
										structuredContent: Schema.Struct({ text: Schema.String }),
									}),
								)(value)
								return Option.isSome(document)
									? [document.value.structuredContent.text]
									: []
							})
							.at(0) ?? ""
					assert.equal(Tool.isDynamic(selected), true)
					return Stream.make(
						Response.makePart("tool-call", {
							id: "app-call-" + last,
							name: selected.name,
							params: input.includes("write")
								? { id: "release-plan", text: priorDocument }
								: input.includes("resource")
									? {}
									: input.includes("prompt")
										? { subject: "Release" }
										: {
												id: input.includes("invalid parameters")
													? 17
													: "release-plan",
											},
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					)
				}),
		}),
	)
	const publicOrigin = "https://openbot.fixture.test"
	const host = await BrowserHost.start({
		publicOrigin,
		model,
		appReadRules: [
			{ cardUrl: publisher.origin + "/card", tool: "read_document" },
		],
		discovery: publisher.discovery,
		appProbe: publisher.probe,
		appNetwork: Layer.succeed(AppNetwork, {
			layer: (owner, origins) =>
				NodeHttpServer.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					ca: publisher.ca,
					allowAddress: (ip) => ip === "127.0.0.1",
				}),
		}),
	})
	try {
		const alice = await host.login("plugin-alice")
		const bob = await host.login("plugin-bob")
		const aliceBot = await host.defaultBot(alice.session)
		const bobBot = await host.defaultBot(bob.session)
		const headers = (session = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(session)),
			origin: publicOrigin,
			"content-type": "application/json",
		})
		const post = (path: string, body: unknown, session = alice.session) =>
			fetch(host.address + path, {
				method: "POST",
				headers: headers(session),
				body: JSON.stringify(body),
			})
		const sender =
			(session: typeof alice.session): Send =>
			(path, method, payload) =>
				fetch(host.address + path, {
					method,
					headers: headers(session),
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
		await host.runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const plugin = (yield* AppPlugin).forOwner(alice.identity)
					yield* plugin.middleware
				}),
			),
		)
		assert.equal(publisher.requests().length, 0)
		for (const [path, name, account] of [
			["/card", "Work documents", "Work"],
			["/second", "Personal documents", "Personal"],
		] as const) {
			const draft = await (
				await post("/v1/connection-drafts", { input: publisher.origin + path })
			).json()
			const response = await post("/v1/connections", {
				draftId: draft.id,
				revision: draft.revision,
				cardUrl: publisher.origin + path,
				remoteIndex: 0,
				values: {
					"header:X-Account": account,
					"header:X-Secret": "private-" + account,
				},
				name,
				confirmed: true,
			})
			assert.equal(response.status, 201, await response.clone().text())
		}
		/** The pending requests of a Chat. */
		const requestsFor = async (
			chat: string,
			session: typeof alice.session,
			view: ChatView,
		): Promise<ReadonlyArray<RequestsApi.CapabilityRequest>> => {
			if (view.open.requests === 0) return []
			for (let tries = 0; tries < 200; tries++) {
				const list = Schema.decodeUnknownSync(
					Schema.Array(RequestsApi.CapabilityRequest),
				)(
					await (
						await fetch(host.address + "/v1/requests?status=pending", {
							headers: headers(session),
						})
					).json(),
				).filter((entry) => entry.chat === chat)
				if (list.length > 0) return list
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			return []
		}
		/** Waits until a Turn after `turn` has run, and the Chat is at rest. */
		const after = async (
			chat: string,
			session: typeof alice.session,
			turn: string | undefined,
		) => {
			for (let tries = 0; tries < 200; tries++) {
				const view = await settled(sender(session), chat)
				if (view.turn !== null && view.turn.id !== turn) return view
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error("No new Turn ran in the Chat " + chat)
		}
		/** The direct Chat of each person with their default Bot. */
		const chats = new Map<typeof alice.session, string>()
		const run = async (input: string, session = alice.session) => {
			const send = sender(session)
			const known = chats.get(session)
			if (known !== undefined) await settled(send, known)
			const callsBefore = publisher.businessCalls()
			const writesBefore = publisher.writes().length
			const receipt = await message(
				send,
				session === alice.session ? aliceBot : bobBot,
				input,
			)
			assert.equal(receipt.delivery, "started")
			chats.set(session, receipt.chat)
			let view = await settled(send, receipt.chat)
			const pending = await requestsFor(receipt.chat, session, view)
			if (input.includes("covered")) assert.equal(pending.length, 0)
			for (const entry of input.includes("hold") ? [] : pending) {
				// The Turn does not wait for the decision. The call has not run yet.
				assert.equal(view.status, "Completed")
				assert.match(JSON.stringify(view.response), /pending/)
				assert.equal(publisher.businessCalls(), callsBefore)
				assert.equal(
					entry.app?.source.connectionName,
					input.includes("write") ? "Personal documents" : "Work documents",
				)
				if (input.includes("write"))
					assert.equal(publisher.writes().length, writesBefore)
				const decided = await post(
					"/v1/requests/" + entry.id,
					{
						expected: entry.revision,
						decision: input.includes("reject") ? "deny" : "allow",
					},
					session,
				)
				assert.equal(decided.status, 200, await decided.clone().text())
				// The decision comes back to the Chat as a message, and starts a new Turn.
				view = await after(receipt.chat, session, view.turn?.id)
			}
			if (input.includes("hold")) return view
			assert.equal(
				view.response?.status,
				"completed",
				JSON.stringify(view.response),
			)
			return view
		}
		/** All Items of a Chat, oldest first, as JSON. */
		const chatItems = async (chat: string) => {
			type Page = {
				readonly items: ReadonlyArray<{
					readonly content: {
						readonly content: ReadonlyArray<{
							readonly role: string
							readonly content: unknown
						}>
					}
				}>
				readonly next: number | null
			}
			let items: Page["items"] = []
			let before: number | null = null
			do {
				const response: globalThis.Response = await fetch(
					host.address +
						`/v1/chats/${chat}/items?` +
						new URLSearchParams({
							limit: "100",
							...(before === null ? {} : { before: String(before) }),
						}),
					{ headers: headers() },
				)
				assert.equal(response.status, 200, await response.clone().text())
				const page = (await response.json()) as Page
				items = [...items, ...page.items]
				before = page.next
			} while (before !== null)
			return items.toReversed()
		}
		await run("Read the document")
		assert.equal(publisher.businessCalls(), 1)
		const aliceChat = chats.get(alice.session)!
		const firstItems = await chatItems(aliceChat)
		const history = JSON.stringify(firstItems)
		assert.match(history, /handler-executed/)
		assert.match(history, /Document content release-plan/)
		assert.match(history, /read_later/)
		assert.match(history, /outputSchema/)
		assert.equal(history.includes("private-Work"), false)
		assert.ok(
			observed[0]?.descriptions.includes(
				"Apply the proposed change after approval",
			),
		)
		assert.equal(
			observed[0]?.descriptions.some((value) =>
				value.includes("hidden_action"),
			),
			false,
		)
		assert.equal(
			observed[0]?.descriptions.filter((value) => value.includes("read_later"))
				.length,
			2,
		)
		for (const input of [
			"Read the resource",
			"Read the template",
			"Read the prompt",
		]) {
			const view = await run(input)
			assert.match(JSON.stringify(view.response), /Completed/)
		}
		const invalid = await run("Read with invalid parameters")
		assert.match(JSON.stringify(invalid.response), /Schema/)
		assert.equal(publisher.businessCalls(), 1)
		publisher.setInvalidOutput(true)
		const malformed = await run("Read malformed output")
		assert.match(JSON.stringify(malformed.response), /Schema/)
		assert.equal(publisher.businessCalls(), 2)
		publisher.setInvalidOutput(false)

		const bobResult = await run("Bob read the document", bob.session)
		assert.match(
			JSON.stringify(bobResult.response),
			/No matching App capability/,
		)
		assert.equal(
			observed
				.at(-1)
				?.descriptions.some((value) => value.includes("Work documents")),
			false,
		)
		assert.equal(publisher.businessCalls(), 2)
		await run("reject write to board")
		assert.equal(publisher.writes().length, 0)
		assert.equal(publisher.businessCalls(), 2)
		const written = await run("write reviewed document to board")
		assert.equal(publisher.writes().length, 1)
		assert.deepEqual(publisher.writes()[0], {
			account: "Personal",
			text: "Document content release-plan",
		})
		assert.match(JSON.stringify(written.response), /Completed/)
		publisher.setInputRequired(true)
		const requiringInput = await run("Read requiring input")
		assert.match(JSON.stringify(requiringInput.response), /InputRequired/)
		assert.equal(publisher.inputStarts(), 1)
		assert.equal(publisher.businessCalls(), 3)
		const operationsResponse = await fetch(
			host.address + `/v1/chats/${aliceChat}/app-operations`,
			{ headers: headers() },
		)
		const operations = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(await operationsResponse.json())
		const pendingInput = operations.find(
			(value) => value.status === "InputRequired",
		)
		assert.ok(pendingInput)
		const operationPath = "/v1/app-operations/" + pendingInput.id
		assert.equal(
			(
				await fetch(host.address + operationPath, {
					headers: headers(bob.session),
				})
			).status,
			404,
		)
		assert.equal(
			(
				await post(operationPath + "/inputs", {
					round: pendingInput.round,
					responses: { other: { action: "accept" } },
				})
			).status,
			409,
		)
		await host.restart()
		assert.equal(publisher.inputStarts(), 1)
		const resumed = await post(operationPath + "/inputs", {
			round: pendingInput.round,
			responses: {
				consent: { action: "accept", content: { confirmed: true } },
			},
		})
		assert.equal(resumed.status, 200, await resumed.clone().text())
		assert.equal((await resumed.json()).status, "Completed")
		assert.equal(publisher.inputStarts(), 1)
		assert.equal(publisher.businessCalls(), 4)
		assert.equal(
			(
				await post(operationPath + "/inputs", {
					round: pendingInput.round,
					responses: {
						consent: { action: "accept", content: { confirmed: true } },
					},
				})
			).status,
			409,
		)
		publisher.setInputRequired(false)
		publisher.setDropResult(true)
		const unknown = await run("Read a result dropped after processing")
		publisher.setDropResult(false)
		assert.match(JSON.stringify(unknown.response), /OutcomeUnknown/)
		assert.equal(publisher.businessCalls(), 5)
		const savedUnknown = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(
			await (
				await fetch(host.address + `/v1/chats/${aliceChat}/app-operations`, {
					headers: headers(),
				})
			).json(),
		)
		assert.equal(
			savedUnknown.filter((value) => value.status === "OutcomeUnknown").length,
			2,
		)
		assert.equal(publisher.businessCalls(), 5)
		await run("ordinary read")
		await run("ordinary covered read")
		assert.equal(publisher.businessCalls(), 7)
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* sql`create function reject_app_receipt() returns trigger language plpgsql as $$ begin if NEW.status = 'Completed' then raise exception 'Fixture receipt persistence failure'; end if; return NEW; end $$`
				yield* sql`create trigger reject_app_receipt before update on openbot_app_invocations for each row execute function reject_app_receipt()`
			}),
		)
		const saveFailed = await run("write with receipt storage unavailable")
		assert.match(JSON.stringify(saveFailed.response), /OutcomeUnknown/)
		assert.equal(publisher.writes().length, 2)
		assert.equal(publisher.businessCalls(), 8)
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* sql`drop trigger reject_app_receipt on openbot_app_invocations`
				yield* sql`drop function reject_app_receipt()`
				const rows = yield* sql<{
					readonly body: string
				}>`select body from openbot_app_invocations`
				for (const row of rows) {
					assert.equal(row.body.includes("Document content"), false)
					assert.equal(row.body.includes("private-Work"), false)
				}
			}),
		)
		const held = await run("hold a document operation")
		const [heldRequest] = await requestsFor(aliceChat, alice.session, held)
		assert.ok(
			heldRequest?.app !== undefined,
			JSON.stringify({ status: held.status, open: held.open, heldRequest }),
		)
		const connection = await (
			await fetch(
				host.address + "/v1/connections/" + heldRequest.app.source.connectionId,
				{ headers: headers() },
			)
		).json()
		const disabled = await fetch(
			host.address + "/v1/connections/" + connection.id,
			{
				method: "PUT",
				headers: headers(),
				body: JSON.stringify({
					revision: connection.revision,
					name: connection.name,
					enabled: false,
				}),
			},
		)
		assert.equal(disabled.status, 200)
		// The decision came after the connection changed, so the call never runs.
		assert.equal(
			(
				await post("/v1/requests/" + heldRequest.id, {
					expected: heldRequest.revision,
					decision: "allow",
				})
			).status,
			200,
		)
		const notRun = await after(aliceChat, alice.session, held.turn?.id)
		assert.match(JSON.stringify(notRun.response), /connection changed/)
		assert.equal(publisher.businessCalls(), 8)
		assert.equal(
			(
				await post("/v1/requests/" + heldRequest.id, {
					expected: heldRequest.revision + 1,
					decision: "allow",
				})
			).status,
			409,
		)
		// The first App result in the Chat. A call that waits for a decision first
		// gets a pending result, and its real result comes later.
		const resultParts = firstItems.flatMap((item) =>
			item.content.content.flatMap((entry) =>
				entry.role === "tool" && Array.isArray(entry.content)
					? (
							entry.content as ReadonlyArray<{
								readonly type: string
								readonly result?: unknown
							}>
						).filter(
							(part) =>
								part.type === "tool-result" &&
								!JSON.stringify(part.result).includes('"pending"'),
						)
					: [],
			),
		)
		const execution = Schema.decodeUnknownSync(AppExecution.Result)(
			resultParts[0]?.result,
		)
		assert.equal(execution.source.connectionName, "Work documents")
		assert.equal(execution.source.name, "read_later")
		assert.equal(execution.source.kind, "tool")
	} finally {
		await host.close()
		await publisher.close()
	}
})
