// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppViewsApi as Api, AuthApi, AppExecution } from "@openbot-build/api"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as Network from "@openbot-build/protocol/NodeHttpServer"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { message, settled, type Send } from "./Messages.ts"
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}
test("App views bind to the real history and account, accept each exact host action once, keep confirmed state and survive view closure", async () => {
	const publisher = await Fixture.start({ capabilities: true })
	const model = await Effect.runPromise(
		LanguageModel.make({
			generateText: () =>
				Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
			streamText: ({ prompt, tools }) => {
				const last = prompt.content.findLastIndex((m) => m.role === "user")
				const input = prompt.content[last]
				// A message from OpenBot, such as a decision, asks for no new App call.
				const notice =
					input?.role === "user" &&
					input.content.some(
						(p) => p.type === "text" && p.text.startsWith("[OpenBot]"),
					)
				const finished =
					notice ||
					prompt.content
						.slice(last + 1)
						.some(
							(m) =>
								m.role === "tool" &&
								m.content.some((p) => p.type === "tool-result"),
						)
				const tool = tools.find((tool) =>
					tool.description?.includes(" / read_document."),
				)
				return finished || tool === undefined
					? Stream.make(Response.makePart("finish", { reason: "stop", usage }))
					: Stream.make(
							Response.makePart("tool-call", {
								id: "document-call",
								name: tool.name,
								params: { id: "alpha" },
								providerExecuted: false,
							}),
							Response.makePart("finish", { reason: "tool-calls", usage }),
						)
			},
		}),
	)
	const publicOrigin = "https://openbot.fixture.test"
	const host = await BrowserHost.start({
		publicOrigin,
		model,
		discovery: publisher.discovery,
		appProbe: publisher.probe,
		appNetwork: Layer.succeed(AppNetwork, {
			layer: (owner, origins) =>
				Network.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					ca: publisher.ca,
					allowAddress: (ip) => ip === "127.0.0.1",
				}),
		}),
	})
	try {
		const alice = await host.login("views-alice"),
			bob = await host.login("views-bob")
		const bot = await host.defaultBot(alice.session)
		await host.defaultBot(bob.session)
		const headers = (cookie = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(cookie)),
			origin: publicOrigin,
			"content-type": "application/json",
		})
		const request = (
			path: string,
			method = "GET",
			body?: unknown,
			cookie = alice.session,
		) =>
			fetch(host.address + path, {
				method,
				headers: headers(cookie),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		const post = (path: string, body: unknown) => request(path, "POST", body)
		const draft = await (
			await post("/v1/connection-drafts", { input: publisher.origin + "/card" })
		).json()
		const added = await post("/v1/connections", {
			draftId: draft.id,
			revision: draft.revision,
			cardUrl: publisher.origin + "/card",
			remoteIndex: 0,
			values: { "header:X-Account": "Work", "header:X-Secret": "secret-work" },
			name: "Work documents",
			confirmed: true,
		})
		assert.equal(added.status, 201, await added.clone().text())
		const asAlice: Send = (path, method, payload) =>
			request(path, method, payload)
		let id = ""
		const wait = () => settled(asAlice, id)
		/** Waits until a Turn after `turn` has run, and the Chat is at rest. */
		const after = async (turn: string | undefined) => {
			for (let tries = 0; tries < 200; tries++) {
				const view = await wait()
				if (view.turn !== null && view.turn.id !== turn) return view
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error("No new Turn ran in the Chat " + id)
		}
		/** All Items of the Chat. */
		const items = async () => {
			type Page = {
				readonly items: ReadonlyArray<{
					readonly id: string
					readonly content: {
						readonly content: ReadonlyArray<{
							readonly role: string
							readonly content: unknown
						}>
					}
				}>
				readonly next: number | null
			}
			let all: Page["items"] = []
			let before: number | null = null
			do {
				const page = (await (
					await request(
						"/v1/chats/" +
							id +
							"/items?" +
							new URLSearchParams({
								limit: "100",
								...(before === null ? {} : { before: String(before) }),
							}),
					)
				).json()) as Page
				all = [...all, ...page.items]
				before = page.next
			} while (before !== null)
			return all
		}
		/**
		 * Answers the one pending request of the Chat. The decision comes back to the
		 * Chat as a message, so this waits until the next Turn has run.
		 */
		const approve = async (accepted = true) => {
			let pending: ReadonlyArray<{
				readonly id: string
				readonly revision: number
				readonly chat: string
			}> = []
			for (let tries = 0; tries < 200 && pending.length === 0; tries++) {
				pending = (
					(await (
						await request("/v1/requests?status=pending")
					).json()) as typeof pending
				).filter((entry) => entry.chat === id)
				if (pending.length === 0)
					await new Promise((resolve) => setTimeout(resolve, 25))
			}
			assert.equal(pending.length, 1)
			const before = (await wait()).turn?.id
			const response = await post("/v1/requests/" + pending[0]!.id, {
				expected: pending[0]!.revision,
				decision: accepted ? "allow" : "deny",
			})
			assert.equal(response.status, 200, await response.clone().text())
			return after(before)
		}
		const receipt = await message(asAlice, bot, "Read the document")
		id = receipt.chat
		await wait()
		await approve()
		const all = Schema.decodeUnknownSync(Schema.Array(AppExecution.Invocation))(
			await (await request("/v1/chats/" + id + "/app-operations")).json(),
		)
		const original = all[0]!
		const item = (await items()).find((item) =>
			item.content.content.some(
				(m) =>
					m.role === "tool" &&
					Array.isArray(m.content) &&
					m.content.some(
						(p: { readonly type: string; readonly id?: string }) =>
							p.type === "tool-result" && p.id === original.callId,
					),
			),
		)!
		const opening = { chatId: id, itemId: item.id }
		const openResponse = await post(
			"/v1/app-operations/" + original.id + "/view",
			opening,
		)
		assert.equal(openResponse.status, 200, await openResponse.clone().text())
		const view = Schema.decodeUnknownSync(Api.Opened)(await openResponse.json())
		assert.equal(view.resource.mimeType, "text/html;profile=mcp-app")
		assert.equal(JSON.stringify(view).includes("secret-work"), false)
		assert.equal(
			(await request("/v1/app-views/" + view.id, "GET", undefined, bob.session))
				.status,
			404,
		)
		assert.equal(
			(
				await post("/v1/app-operations/" + original.id + "/view", {
					...opening,
					itemId: "arbitrary",
				})
			).status,
			404,
		)
		const context = {
			content: [{ type: "text", text: "Confirmed selection alpha" }],
		}
		const saved = await request(
			"/v1/app-views/" + view.id + "/context",
			"PUT",
			{ revision: 0, context },
		)
		assert.equal(saved.status, 200, await saved.clone().text())
		assert.equal(
			(
				await request("/v1/app-views/" + view.id + "/context", "PUT", {
					revision: 0,
					context,
				})
			).status,
			409,
		)

		const action = {
			kind: "tool",
			requestId: "write-one",
			name: "write_board",
			arguments: { id: "alpha", text: "Reviewed document" },
		}
		const accepted = await post("/v1/app-views/" + view.id + "/actions", action)
		assert.equal(accepted.status, 202, await accepted.clone().text())
		const ticket = await accepted.json()
		const duplicate = await post(
			"/v1/app-views/" + view.id + "/actions",
			action,
		)
		assert.equal(duplicate.status, 202, await duplicate.clone().text())
		assert.deepEqual(await duplicate.json(), ticket)
		assert.equal(
			(
				await post("/v1/app-views/" + view.id + "/actions", {
					...action,
					arguments: { id: "different", text: "No" },
				})
			).status,
			409,
		)
		await wait()
		assert.equal(publisher.writes().length, 0)
		assert.equal(
			(await request("/v1/app-views/" + view.id, "DELETE")).status,
			200,
		)
		await approve()
		assert.deepEqual(publisher.writes(), [
			{ account: "Work", text: "Reviewed document" },
		])
		assert.equal(
			(
				await post("/v1/app-views/" + view.id + "/actions", {
					...action,
					requestId: "closed",
				})
			).status,
			404,
		)
		const restoredResponse = await post(
			"/v1/app-operations/" + original.id + "/view",
			opening,
		)
		const restored = Schema.decodeUnknownSync(Api.Opened)(
			await restoredResponse.json(),
		)
		assert.deepEqual(restored.interaction, { revision: 1, context })
		assert.equal(publisher.writes().length, 1)
		const appOnly = await post("/v1/app-views/" + restored.id + "/actions", {
			kind: "tool",
			requestId: "app-only",
			name: "hidden_action",
			arguments: { id: "alpha" },
		})
		assert.equal(appOnly.status, 202, await appOnly.clone().text())
		await wait()
		await approve(false)
		assert.equal(publisher.businessCalls(), 2)
		const record = await (
			await request("/v1/chats/" + id + "/app-operations")
		).json()
		assert.equal(
			record.some(
				(r: { source: { name: string }; status: string }) =>
					r.source.name === "hidden_action" && r.status === "Rejected",
			),
			true,
		)
		await host.restart()
		assert.equal((await request("/v1/app-views/" + restored.id)).status, 404)
		const durable = await (
			await post("/v1/app-operations/" + original.id + "/view", opening)
		).json()
		assert.deepEqual(durable.interaction, { revision: 1, context })
		assert.equal(publisher.writes().length, 1)
		const exportedResponse = await request("/v1/app-experience/export")
		assert.equal(
			exportedResponse.status,
			200,
			await exportedResponse.clone().text(),
		)
		const exported = await exportedResponse.json()
		assert.deepEqual(exported, {
			format: "openbot-apps-v1",
			apps: [
				{
					name: "Work documents",
					cardUrl: publisher.origin + "/card",
					remoteIndex: 0,
				},
			],
		})
		const importedResponse = await request(
			"/v1/app-experience/import",
			"POST",
			exported,
			bob.session,
		)
		assert.equal(
			importedResponse.status,
			200,
			await importedResponse.clone().text(),
		)
		const imported = await importedResponse.json()
		assert.equal(imported.entries[0].draft.discovery._tag, "Single")
		assert.deepEqual(
			await (
				await request("/v1/connections", "GET", undefined, bob.session)
			).json(),
			[],
		)
		const bobDraft = imported.entries[0].draft
		const bobConnection = await request(
			"/v1/connections",
			"POST",
			{
				draftId: bobDraft.id,
				revision: bobDraft.revision,
				cardUrl: publisher.origin + "/card",
				remoteIndex: 0,
				values: { "header:X-Account": "Bob", "header:X-Secret": "secret-bob" },
				name: "Bob documents",
				confirmed: true,
			},
			bob.session,
		)
		assert.equal(bobConnection.status, 201, await bobConnection.clone().text())
		const resetResponse = await post("/v1/app-experience/reset", {})
		assert.equal(resetResponse.status, 200, await resetResponse.clone().text())
		const reset = await resetResponse.json()
		assert.equal(reset.removed.length, 1)
		assert.deepEqual(reset.pending, [])
		assert.deepEqual(await (await request("/v1/connections")).json(), [])
		assert.equal(
			(
				await (
					await request("/v1/connections", "GET", undefined, bob.session)
				).json()
			).length,
			1,
		)
		assert.equal((await items()).length > 0, true)
		assert.equal(
			(await (await request("/v1/chats/" + id + "/app-operations")).json())
				.length > 0,
			true,
		)
		assert.equal(publisher.writes().length, 1)
	} finally {
		await host.close()
		await publisher.close()
	}
})
