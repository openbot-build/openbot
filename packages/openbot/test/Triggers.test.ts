import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import {
	Authorization,
	ChatSummary,
	ChatView,
	DelegationsApi,
	TriggersApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { dataNote } from "../src/triggers/Fire.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://triggers.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")

/** The model answers with the last user message, so the test can see what came in. */
const model = Effect.runSync(
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) => {
			const last = prompt.content.findLast((message) => message.role === "user")
			return Stream.make(
				Response.makePart("text-start", { id: "answer" }),
				Response.makePart("text-delta", {
					id: "answer",
					delta: "Got: " + (last === undefined ? "" : textOf(last)),
				}),
				Response.makePart("text-end", { id: "answer" }),
				Response.makePart("finish", { reason: "stop", usage }),
			)
		},
	}),
)

const client = (host: Awaited<ReturnType<typeof BrowserHost.start>>) => {
	const send = (
		credential: Redacted.Redacted<string> | undefined,
		path: string,
		method = "GET",
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		fetch(host.address + path, {
			method,
			headers: {
				...(credential === undefined
					? {}
					: {
							cookie:
								"__Host-openbot-session=" +
								encodeURIComponent(Redacted.value(credential)),
						}),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
				...headers,
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	const json = async <A, I>(
		schema: Schema.Codec<A, I>,
		response: Promise<globalThis.Response>,
	): Promise<A> => {
		const value = await response
		const body = await value.text()
		assert.ok(value.ok, value.status + " " + body)
		return Schema.decodeUnknownSync(schema)(JSON.parse(body))
	}
	const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await pause()
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

it(
	"a trigger gives its prompt to its Bot on a schedule and from a webhook, the result comes to the Chat of the actor, and only those who may use it",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			triggerIntervalMs: 100,
		})
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("triggers-alice")
			const bob = await host.login("triggers-bob")
			await host.defaultBot(alice.session)
			await host.defaultBot(bob.session)
			const tasks = async (credential: Redacted.Redacted<string>) =>
				json(Schema.Array(ChatSummary), send(credential, "/v1/chats?kind=task"))
			const delegation = (id: string) =>
				json(
					DelegationsApi.Delegation,
					send(alice.session, "/v1/delegations/" + id),
				)
			const completed = (id: string) =>
				until("the work of the trigger ends", async () => {
					const work = await delegation(id)
					return work.status === "completed" ? work : undefined
				})
			const history = async (chat: string) =>
				JSON.stringify(
					await json(
						Schema.Struct({ items: Schema.Array(Item.Record) }),
						send(alice.session, "/v1/chats/" + chat + "/items?limit=100"),
					),
				)
			const rested = (chat: string) =>
				until("the Chat comes to rest", async () => {
					const view = await json(
						ChatView,
						send(alice.session, "/v1/chats/" + chat),
					)
					return view.status !== "Running" &&
						view.activity !== "active" &&
						view.inbox === 0
						? view
						: undefined
				})

			// A schedule that is not valid is refused.
			const wrong = await send(alice.session, "/v1/triggers", "POST", {
				prompt: "Check the build.",
				schedule: { cron: "every day" },
			})
			assert.strictEqual(wrong.status, 400)

			// The schedule fires. The test moves its next time to now.
			const daily = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers", "POST", {
					prompt: "Check the build.",
					schedule: { cron: "0 9 * * *", timeZone: "Europe/Berlin" },
				}),
			)
			assert.strictEqual(daily.actor, alice.identity.userId)
			assert.ok(daily.nextRunAt !== null && daily.nextRunAt > Date.now())
			await host.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					yield* sql`update openbot_triggers set next_run_at = 0 where id = ${daily.id}`
				}),
			)
			const scheduled = await until("a task of the schedule", async () => {
				const list = await tasks(alice.session)
				return list[0]
			})
			assert.ok(scheduled.chat.parent !== null)
			const work = await completed(scheduled.chat.parent.delegation)
			assert.strictEqual(work.trigger, daily.id)
			assert.strictEqual(work.chat, scheduled.chat.id)
			console.log(
				"DEBUG",
				JSON.stringify(work),
				await history(scheduled.chat.id),
			)
			// The task comes in as a note from OpenBot, and the model repeats it.
			assert.match(work.result ?? "", /^Got: .*Check the build\./s)
			assert.match(await history(scheduled.chat.id), /Got: .*Check the build\./)
			// The result comes to the direct Chat of the actor with the Bot as a notice.
			const direct = work.parent.chat
			await until("the notice of the result", async () =>
				(await history(direct)).includes(work.id) ? true : undefined,
			)
			const rest = await rested(direct)
			assert.strictEqual(rest.chat.kind, "direct")
			assert.strictEqual(rest.status, "Completed")
			const after = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers/" + daily.id),
			)
			assert.ok(after.lastFiredAt !== null)
			assert.ok(after.nextRunAt !== null && after.nextRunAt > Date.now())

			// A webhook fires with its secret only. The body goes in as data.
			const hook = await json(
				TriggersApi.WebhookSecret,
				send(alice.session, "/v1/triggers/" + daily.id + "/webhook", "PUT"),
			)
			assert.strictEqual(
				hook.url,
				publicOrigin + "/v1/hooks/triggers/" + daily.id,
			)
			const denied = await send(
				undefined,
				"/v1/hooks/triggers/" + daily.id,
				"POST",
				{ order: 42 },
				{ authorization: "Bearer wrong" },
			)
			assert.strictEqual(denied.status, 401)
			const fired = await json(
				Schema.Struct({ delegation: DelegationsApi.DelegationId }),
				send(
					undefined,
					"/v1/hooks/triggers/" + daily.id,
					"POST",
					{ order: 42 },
					{ authorization: "Bearer " + hook.secret },
				),
			)
			const hooked = await completed(fired.delegation)
			assert.ok(hooked.chat !== null)
			const text = await history(hooked.chat)
			assert.ok(text.includes(dataNote))
			assert.match(text, /order/)

			// A disabled trigger does not fire from its webhook.
			const disabled = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers/" + daily.id, "PATCH", {
					expected: after.revision + 1,
					enabled: false,
				}),
			)
			assert.strictEqual(disabled.nextRunAt, null)
			const off = await send(
				undefined,
				"/v1/hooks/triggers/" + daily.id,
				"POST",
				{},
				{ authorization: "Bearer " + hook.secret },
			)
			assert.strictEqual(off.status, 401)

			// Bob cannot see the trigger of Alice, and a member cannot make shared triggers.
			assert.strictEqual(
				(await send(bob.session, "/v1/triggers/" + daily.id)).status,
				404,
			)
			const shared = await send(bob.session, "/v1/triggers", "POST", {
				prompt: "Say hello.",
				shared: true,
			})
			assert.strictEqual(shared.status, 403, await shared.clone().text())
			const team = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers", "POST", {
					prompt: "Say hello.",
					shared: true,
				}),
			)
			assert.deepStrictEqual(team.owner, { _tag: "Organization" })
			const seen = await json(
				Schema.Array(TriggersApi.Trigger),
				send(bob.session, "/v1/triggers"),
			)
			assert.deepStrictEqual(
				seen.map((trigger) => trigger.id),
				[team.id],
			)
			const change = await send(
				bob.session,
				"/v1/triggers/" + team.id,
				"PATCH",
				{
					expected: team.revision,
					prompt: "Say goodbye.",
				},
			)
			assert.strictEqual(change.status, 403)
			assert.strictEqual(
				(await send(alice.session, "/v1/triggers/" + team.id, "DELETE")).status,
				204,
			)
		} finally {
			await host.close()
		}
	},
)

it(
	"a deny rule on one trigger hides it from the list and from a read",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json } = client(host)
			const alice = await host.login("triggers-deny")
			await host.defaultBot(alice.session)
			const create = (prompt: string) =>
				json(
					TriggersApi.Trigger,
					send(alice.session, "/v1/triggers", "POST", { prompt }),
				)
			const open = await create("Open")
			const hidden = await create("Hidden")
			const listed = async () =>
				(
					await json(
						Schema.Array(TriggersApi.Trigger),
						send(alice.session, "/v1/triggers"),
					)
				).map((trigger) => trigger.id)
			assert.sameMembers(await listed(), [open.id, hidden.id])

			const changed = await send(
				alice.session,
				"/v1/organization/members/" + encodeURIComponent(alice.identity.userId),
				"PATCH",
				{
					policy: Policies.json(function* (_) {
						yield* _.deny("read", Authorization.Trigger, {
							when: ($) => $.eq("id", hidden.id),
						})
					}),
				},
			)
			assert.strictEqual(changed.status, 200, await changed.clone().text())
			// The list query has the condition of the policy, so the database
			// leaves out the trigger.
			assert.deepStrictEqual(await listed(), [open.id])
			assert.strictEqual(
				(await send(alice.session, "/v1/triggers/" + hidden.id)).status,
				404,
			)
		} finally {
			await host.close()
		}
	},
)
