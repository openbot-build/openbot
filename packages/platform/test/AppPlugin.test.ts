// @effect-diagnostics strictEffectProvide:off
import { PgClient } from "@effect/sql-pg"
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppExecution, AuthApi, SessionView } from "@openbot-build/platform-api"
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
import { AppPlugin } from "../src/apps/AppPlugin.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

test("the Platform App plugin combines live paged capabilities with caller tools and records real handler results for the current account", async () => {
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
	const publicOrigin = "https://platform.fixture.test"
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
		await host.runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const plugin = (yield* AppPlugin).forOwner(alice.identity)
					yield* plugin.middleware
				}),
			),
		)
		const empty = await post("/v1/sessions", {})
		assert.equal(empty.status, 201)
		assert.equal(publisher.requests().length, 0)
		const work = Schema.decodeUnknownSync(SessionView)(await empty.json())
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
		const get = async (id: string, session = alice.session) =>
			Schema.decodeUnknownSync(SessionView)(
				await (
					await fetch(host.address + "/v1/sessions/" + id, {
						headers: headers(session),
					})
				).json(),
			)
		const wait = async (id: string, session = alice.session) => {
			let view = await get(id, session)
			for (let index = 0; view.activity === "active" && index < 30; index++)
				view = Schema.decodeUnknownSync(SessionView)(
					await (
						await fetch(
							host.address +
								"/v1/sessions/" +
								id +
								"/wait?" +
								new URLSearchParams({
									after: String(view.session.revision),
									afterActivity: view.activity,
									timeoutMs: "1000",
								}),
							{ headers: headers(session) },
						)
					).json(),
				)
			assert.notEqual(view.activity, "active")
			return view
		}
		const run = async (
			input: string,
			session = alice.session,
			id = work.session.id,
		) => {
			const current = await get(id, session)
			const callsBefore = publisher.businessCalls()
			const writesBefore = publisher.writes().length
			const response = await post(
				"/v1/sessions/" + id + "/turns",
				{ input, expected: current.session.revision },
				session,
			)
			assert.equal(response.status, 202, await response.clone().text())
			let view = await wait(id, session)
			const approvals = await (
				await fetch(host.address + "/v1/sessions/" + id + "/approvals", {
					headers: headers(session),
				})
			).json()
			if (input.includes("covered")) assert.equal(approvals.length, 0)
			for (const approval of input.includes("hold") ? [] : approvals) {
				assert.equal(publisher.businessCalls(), callsBefore)
				assert.equal(
					approval.app.source.connectionName,
					input.includes("write") ? "Personal documents" : "Work documents",
				)
				if (input.includes("write"))
					assert.equal(publisher.writes().length, writesBefore)
				const approved = await post(
					`/v1/sessions/${id}/turns/${approval.turn}/approvals/${approval.approvalId}`,
					{
						expected: view.session.revision,
						approved: !input.includes("reject"),
						grantReads: input.includes("ordinary"),
					},
					session,
				)
				assert.equal(approved.status, 202, await approved.clone().text())
				view = await wait(id, session)
			}
			if (input.includes("hold")) return view
			assert.equal(
				view.response?.status,
				"completed",
				JSON.stringify(view.response),
			)
			return view
		}
		const completed = await run("Read the document")
		assert.equal(publisher.businessCalls(), 1)
		const history = JSON.stringify(completed.state.value.conversation.history)
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

		const bobWork = await (await post("/v1/sessions", {}, bob.session)).json()
		const bobResult = await run(
			"Bob read the document",
			bob.session,
			bobWork.session.id,
		)
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
			host.address + `/v1/sessions/${work.session.id}/app-operations`,
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
				await fetch(
					host.address + `/v1/sessions/${work.session.id}/app-operations`,
					{ headers: headers() },
				)
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
		const heldApprovals = await (
			await fetch(host.address + `/v1/sessions/${work.session.id}/approvals`, {
				headers: headers(),
			})
		).json()
		assert.equal(heldApprovals.length, 1)
		const heldApproval = heldApprovals[0]
		const connection = await (
			await fetch(
				host.address +
					"/v1/connections/" +
					heldApproval.app.source.connectionId,
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
		assert.equal(
			(
				await post(
					`/v1/sessions/${work.session.id}/turns/${heldApproval.turn}/approvals/${heldApproval.approvalId}`,
					{ expected: held.session.revision, approved: true },
				)
			).status,
			409,
		)
		assert.equal(publisher.businessCalls(), 8)
		assert.equal(
			(
				await post(
					`/v1/sessions/${work.session.id}/turns/${heldApproval.turn}/interrupt`,
					{},
				)
			).status,
			200,
		)
		assert.equal(
			(
				await post(
					`/v1/sessions/${work.session.id}/turns/${heldApproval.turn}/approvals/${heldApproval.approvalId}`,
					{ expected: held.session.revision, approved: true },
				)
			).status,
			409,
		)
		const resultParts =
			completed.state.value.conversation.context.prompt.content.flatMap(
				(message) =>
					Match.value(message).pipe(
						Match.when({ role: "tool" }, (message) =>
							message.content.filter((part) => part.type === "tool-result"),
						),
						Match.orElse(() => []),
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
