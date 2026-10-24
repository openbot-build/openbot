// @effect-diagnostics strictEffectProvide:off
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { AuthApi, CodeRunsApi, RequestsApi } from "@openbot-build/api"
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
import { LanguageModel, Response } from "effect/ai"
import { AppNetwork } from "../src/apps/AppHost.ts"
import type { Binding } from "../src/apps/Bindings.ts"
import { name } from "../src/code/CodeRuns.ts"
import { declarations } from "../src/code/Declarations.ts"
import type { Call } from "../src/code/Protocol.ts"
import { make as makeSandbox, type Program } from "../src/code/Sandbox.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { message, settled, type Send } from "./Messages.ts"

const limits = {
	timeoutMs: 2_000,
	memoryBytes: 32 * 1024 * 1024,
	outputBytes: 4_096,
}
/** Runs a program. Each App call answers with its name and arguments. */
const runProgram = (code: string, options: Partial<Program> = {}) =>
	Effect.gen(function* () {
		const sandbox = yield* makeSandbox
		let seen: ReadonlyArray<Call> = []
		const outcome = yield* sandbox.run(
			{
				code,
				bindings: ["calendar.list", "calendar.add"],
				seed: 7,
				clock: 1_000,
				limits,
				...options,
			},
			(calls) =>
				Effect.sync(() => {
					seen = [...seen, ...calls]
					return Option.some(
						calls.map((call) => ({
							index: call.index,
							ok: true as const,
							value: JSON.stringify({
								binding: call.binding,
								arguments: JSON.parse(call.arguments),
							}),
						})),
					)
				}),
		)
		return { outcome, seen }
	})

it.effect(
	"a program runs in a closed sandbox and gets its App results in order",
	() =>
		Effect.gen(function* () {
			const { outcome, seen } = yield* runProgram(`
		const [a, b] = await Promise.all([
			apps.calendar.list({ day: 1 }),
			apps.call("calendar.add", { title: "Lunch" }),
		])
		console.log("first", a.arguments.day)
		return { a, b, now: Date.now(), date: new Date().getTime(), random: Math.random() }
	`)
			assert.strictEqual(outcome._tag, "Done")
			assert.deepStrictEqual(
				seen.map((call) => [call.index, call.binding]),
				[
					[0, "calendar.list"],
					[1, "calendar.add"],
				],
			)
			if (outcome._tag !== "Done") return
			assert.deepStrictEqual(outcome.logs, ["first 1"])
			const value = outcome.value as Record<string, unknown>
			assert.strictEqual(value["now"], 1_000)
			assert.strictEqual(value["date"], 1_000)
			// The same seed gives the same random numbers in each run.
			const again = yield* runProgram("return Math.random()")
			const other = yield* runProgram("return Math.random()", { seed: 8 })
			assert.strictEqual(
				again.outcome._tag === "Done" && again.outcome.value,
				value["random"],
			)
			assert.notStrictEqual(
				other.outcome._tag === "Done" && other.outcome.value,
				value["random"],
			)
		}),
)

// The limits test needs real time: the sandbox stops a program after a real timeout.
it.live(
	"a program has no Node.js, and the sandbox stops programs at their limits",
	() =>
		Effect.gen(function* () {
			const closed = yield* runProgram(
				"return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.__openbot_host]",
			)
			assert.deepStrictEqual(
				closed.outcome._tag === "Done" && closed.outcome.value,
				["undefined", "undefined", "undefined", "undefined", "undefined"],
			)
			const cases = [
				["while (true) {}", "Timeout"],
				["const list = []; for (;;) list.push({ a: [1, 2, 3] })", "Memory"],
				["return 'x'.repeat(10000)", "OutputTooLarge"],
				["throw new Error('boom')", "Error"],
				["await new Promise(() => {})", "Error"],
				["return apps.calendar.remove({})", "Error"],
				["return apps.calendar.list('not an object')", "Error"],
			] as const
			for (const [code, reason] of cases) {
				const { outcome, seen } = yield* runProgram(code)
				assert.strictEqual(outcome._tag, "Failed", code)
				assert.strictEqual(
					outcome._tag === "Failed" && outcome.reason,
					reason,
					code,
				)
				assert.strictEqual(seen.length, 0, code)
			}
			const logged = yield* runProgram(
				"for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1",
			)
			assert.strictEqual(logged.outcome._tag, "Done")
			if (logged.outcome._tag === "Done")
				assert.strictEqual(
					logged.outcome.logs.at(-1),
					"[More output was cut off.]",
				)
			// An App error reaches the program as an Error that it can catch.
			const denying = yield* makeSandbox
			const failing = yield* denying.run(
				{
					code: "try { await apps.calendar.list({}) } catch (error) { return [error.name, error.details.operationId] }",
					bindings: ["calendar.list"],
					seed: 1,
					clock: 1,
					limits,
				},
				(calls) =>
					Effect.succeedSome(
						calls.map((call) => ({
							index: call.index,
							ok: false as const,
							error: JSON.stringify({
								name: "AppCallDenied",
								message: "No.",
								details: { operationId: "op_1" },
							}),
						})),
					),
			)
			assert.deepStrictEqual(failing._tag === "Done" && failing.value, [
				"AppCallDenied",
				"op_1",
			])
			// When the host gives no answer, the program stops and waits.
			const silent = yield* makeSandbox
			const stopped = yield* silent.run(
				{
					code: "await apps.calendar.list({}); return 1",
					bindings: ["calendar.list"],
					seed: 1,
					clock: 1,
					limits,
				},
				() => Effect.succeedNone,
			)
			assert.strictEqual(stopped._tag, "Stopped")
		}),
)

it("each binding gets a stable short name and a TypeScript declaration", () => {
	const binding = (
		connectionId: string,
		connectionName: string,
		toolName: string,
		kind: "tool" | "resource" = "tool",
	): Binding => ({
		name: "openbot_" + toolName,
		source: {
			connectionId,
			connectionName,
			cardUrl: "https://apps.example.com/card",
			appName: "Example",
			remoteIndex: 0,
			revision: 0,
			kind,
			name: toolName,
		},
		schema: {
			type: "object",
			properties: {
				day: { type: "integer", description: "The day of the month." },
				tags: { type: "array", items: { type: "string" } },
				mode: { enum: ["fast", "slow"] },
			},
			required: ["day"],
		},
		description: "Lists events.",
		needsDecision: kind === "tool",
		readOnly: false,
		perform: () => Effect.die("unused"),
	})
	const named = name([
		binding("b", "Work calendar", "list-events"),
		binding("a", "Work calendar", "list-events"),
		binding("a", "Work calendar", "notes://index", "resource"),
		binding("c", "Call", "add"),
	])
	assert.deepStrictEqual(
		named.map((entry) => entry.alias),
		[
			"work_calendar.notes_index_resource",
			"work_calendar.list_events",
			"work_calendar_2.list_events",
			"call_2.add",
		],
	)
	const text = declarations(named, ({ alias }) =>
		alias.startsWith("work_calendar."),
	)
	assert.match(text, /declare const apps: \{/)
	assert.match(
		text,
		/list_events\(args: \{ \/\*\* The day of the month\. \*\/ "day": number; "tags"\?: Array<string>; "mode"\?: "fast" \| "slow" \}\): Promise<ToolResult>/,
	)
	assert.match(text, /notes_index_resource\(args: .*\): Promise<ReadResult>/)
	assert.strictEqual(text.includes("work_calendar_2"), false)
})

it("Code Mode sends App calls through the same checks, goes on after decisions, and never sends a call twice", async () => {
	const publisher = await Fixture.start({ capabilities: true })
	let observed: ReadonlyArray<ReadonlyArray<string>> = []
	const usage = {
		inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 5, text: 5, reasoning: 0 },
	}
	const answer = (text: string) =>
		Stream.make(
			Response.makePart("text-start", { id: "answer" }),
			Response.makePart("text-delta", { id: "answer", delta: text }),
			Response.makePart("text-end", { id: "answer" }),
			Response.makePart("finish", { reason: "stop", usage }),
		)
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
					// A message from OpenBot, such as the end of a program, is not a program.
					if (input.startsWith("[OpenBot]")) return answer(input)
					observed = Arr.append(
						observed,
						tools.map((tool) => tool.name),
					)
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
					if (result !== undefined) return answer(JSON.stringify(result.result))
					if (!tools.some((tool) => tool.name === "openbot_run_code"))
						return answer("Code Mode is not available.")
					return Stream.make(
						Response.makePart("tool-call", {
							id: "code-call-" + last,
							name: "openbot_run_code",
							params: { code: input, reason: "The test needs it." },
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
		// Reading documents needs no decision. Writing to the board does.
		appReadRules: [
			{ cardUrl: publisher.origin + "/card", tool: "read_document" },
		],
		codeMode: {
			enabled: true,
			timeoutMs: 5_000,
			memoryMb: 32,
			outputBytes: 64 * 1024,
		},
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
		const alice = await host.login("code-alice")
		const bob = await host.login("code-bob")
		const bot = await host.defaultBot(alice.session)
		await host.defaultBot(bob.session)
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
		const read = (path: string, session = alice.session) =>
			fetch(host.address + path, { headers: headers(session) })
		const asAlice: Send = (path, method, payload) =>
			fetch(host.address + path, {
				method,
				headers: headers(),
				...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
			})
		for (const [path, connectionName, account] of [
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
				name: connectionName,
				confirmed: true,
			})
			assert.strictEqual(response.status, 201, await response.clone().text())
		}
		let chat = ""
		const pending = async () => {
			for (let tries = 0; tries < 200; tries++) {
				const list = Schema.decodeUnknownSync(
					Schema.Array(RequestsApi.CapabilityRequest),
				)(await (await read("/v1/requests?status=pending")).json()).filter(
					(entry) => entry.chat === chat,
				)
				if (list.length > 0) return list
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			return []
		}
		/** Waits until the Chat is at rest and its last answer has this text. */
		const answered = async (text: RegExp) => {
			for (let tries = 0; tries < 200; tries++) {
				const view = await settled(asAlice, chat)
				if (text.test(JSON.stringify(view.response))) return view
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error("The Chat did not answer with " + text)
		}
		const start = async (code: string) => {
			const receipt = await message(asAlice, bot, code)
			if (chat === "") chat = receipt.chat
			assert.strictEqual(receipt.chat, chat)
			assert.strictEqual(receipt.delivery, "started")
			return settled(asAlice, chat)
		}
		const decide = async (decision: "allow" | "deny") => {
			const [request] = await pending()
			assert.ok(request, "A call of the program waits for a decision.")
			const decided = await post("/v1/requests/" + request.id, {
				expected: request.revision,
				decision,
			})
			assert.strictEqual(decided.status, 200, await decided.clone().text())
			return request
		}
		/** While a call waits, the Turn ends, and the Bot reads that the call is pending. */
		const paused = (view: Awaited<ReturnType<typeof settled>>) => {
			assert.strictEqual(view.status, "Completed")
			assert.strictEqual(view.open.requests, 1)
			assert.match(JSON.stringify(view.response), /pending/)
		}

		// Reads that need no decision run at once, and together.
		const reads = await start(`
			const [a, b] = await Promise.all([
				apps.work_documents.read_document({ id: "one" }),
				apps.work_documents.read_document({ id: "two" }),
			])
			console.log("read", a.structuredContent.id)
			return [a.structuredContent.text, b.structuredContent.text]
		`)
		assert.strictEqual(
			reads.response?.status,
			"completed",
			JSON.stringify(reads.response),
		)
		assert.match(JSON.stringify(reads.response), /Document content one/)
		assert.match(JSON.stringify(reads.response), /Document content two/)
		assert.strictEqual(publisher.businessCalls(), 2)
		assert.ok(observed[0]?.includes("openbot_code_api"))

		// A denied call reaches the program as an error that it can catch.
		const deniedTurn = await start(`
			try {
				await apps.personal_documents.write_board({ id: "draft", text: "Never sent" })
				return "sent"
			} catch (error) {
				return error.name
			}
		`)
		paused(deniedTurn)
		const denial = await decide("deny")
		assert.strictEqual(denial.code?.index, 0)
		assert.match(denial.code?.code ?? "", /write_board/)
		assert.strictEqual(denial.app?.source.connectionName, "Personal documents")
		// The program goes on in the background. Its result comes back as a message.
		await answered(/AppCallDenied/)
		assert.strictEqual(publisher.writes().length, 0)
		assert.strictEqual(publisher.businessCalls(), 2)

		// The program waits for the write. After the decision it runs again in the
		// background, and the read before the write is not sent again.
		const waiting = await start(`
			const document = await apps.work_documents.read_document({ id: "plan" })
			await apps.personal_documents.write_board({
				id: "plan",
				text: document.structuredContent.text,
			})
			return "written"
		`)
		paused(waiting)
		assert.strictEqual(publisher.businessCalls(), 3)
		assert.strictEqual(publisher.writes().length, 0)
		const allowed = await decide("allow")
		assert.strictEqual(allowed.code?.index, 1)
		const written = await answered(/written/)
		assert.strictEqual(
			written.response?.status,
			"completed",
			JSON.stringify(written.response),
		)
		assert.strictEqual(publisher.businessCalls(), 4)
		assert.deepStrictEqual(publisher.writes(), [
			{ account: "Personal", text: "Document content plan" },
		])

		// A program that makes other calls when it runs again stops, so no call goes out by mistake.
		const changing = await start(`
			const count = Object.keys(apps).length
			if (count === 3) await apps.work_documents.read_document({ id: "check" })
			await apps.personal_documents.write_board({ id: "check", text: "Never sent" })
			return count
		`)
		paused(changing)
		assert.strictEqual(publisher.businessCalls(), 5)
		const connections = (await (
			await read("/v1/connections")
		).json()) as ReadonlyArray<{
			readonly id: string
			readonly name: string
			readonly revision: number
		}>
		const workConnection = connections.find(
			(connection) => connection.name === "Work documents",
		)
		assert.ok(workConnection, JSON.stringify(connections))
		const disabled = await fetch(
			host.address + "/v1/connections/" + workConnection.id,
			{
				method: "PUT",
				headers: headers(),
				body: JSON.stringify({
					revision: workConnection.revision,
					name: workConnection.name,
					enabled: false,
				}),
			},
		)
		assert.strictEqual(disabled.status, 200, await disabled.clone().text())
		await decide("allow")
		await answered(/ReplayMismatch/)
		assert.strictEqual(publisher.businessCalls(), 5)
		assert.strictEqual(publisher.writes().length, 1)

		// People read the programs of their Chats with the cookie or with a token.
		const runs = Schema.decodeUnknownSync(Schema.Array(CodeRunsApi.CodeRun))(
			await (await read("/v1/chats/" + chat + "/code-runs")).json(),
		)
		assert.deepStrictEqual(
			runs.map((run) => [run.status, run.calls.length]),
			[
				["Completed", 2],
				["Completed", 1],
				["Completed", 2],
				["Failed", 2],
			],
		)
		assert.deepStrictEqual(
			runs[2]?.calls.map((call) => call.outcome._tag),
			["Done", "Done"],
		)
		assert.strictEqual(runs[1]?.calls[0]?.outcome._tag, "Denied")
		const token = await (
			await post("/v1/user/tokens", { name: "code runs" })
		).json()
		const withToken = await fetch(
			host.address + "/v1/code-runs/" + runs[2]!.id,
			{ headers: { authorization: "Bearer " + token.secret } },
		)
		assert.strictEqual(withToken.status, 200, await withToken.clone().text())
		assert.strictEqual(
			Schema.decodeUnknownSync(CodeRunsApi.CodeRun)(await withToken.json()).id,
			runs[2]!.id,
		)
		assert.strictEqual(
			(await read("/v1/code-runs/" + runs[2]!.id, bob.session)).status,
			404,
		)
		// Each App call of a program is also an App operation.
		const operations = (await (
			await read("/v1/chats/" + chat + "/app-operations")
		).json()) as ReadonlyArray<{ readonly callId: string }>
		assert.strictEqual(
			operations.filter((operation) => operation.callId.includes(":")).length,
			7,
		)
		// The stored programs are sealed, like App operations.
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly body: string
				}>`select body from openbot_code_runs`
				assert.strictEqual(rows.length, 4)
				for (const row of rows) {
					assert.strictEqual(row.body.includes("Document content"), false)
					assert.strictEqual(row.body.includes("write_board"), false)
				}
			}),
		)

		// When the platform turns Code Mode off, the Bot does not get its tools.
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const settings = yield* Settings
				const current = yield* settings.platform
				if (Option.isNone(current)) return
				yield* settings.updatePlatform(current.value.version, (document) =>
					Effect.succeed({
						...document,
						codeMode: { ...document.codeMode!, enabled: false },
					}),
				)
			}),
		)
		const off = await start("return 1")
		assert.match(JSON.stringify(off.response), /Code Mode is not available/)
		assert.strictEqual(observed.at(-1)?.includes("openbot_run_code"), false)
	} finally {
		await host.close()
		await publisher.close()
	}
})
