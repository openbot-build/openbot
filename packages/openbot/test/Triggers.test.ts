import assert from "node:assert/strict"
import { test } from "node:test"
import { PgClient } from "@effect/sql-pg"
import { Session } from "@openbot-build/core"
import { SessionView, TriggersApi } from "@openbot-build/api"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { dataNote } from "../src/triggers/Fire.ts"
import * as BrowserHost from "./BrowserHost.ts"

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

test(
	"a trigger starts a Session with its prompt on a schedule and from a webhook, and only for those who may",
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
			await host.defaultAgent(alice.session)
			await host.defaultAgent(bob.session)
			const sessions = async (credential: Redacted.Redacted<string>) =>
				json(
					Schema.Array(
						Schema.Struct({ session: Session.Ref, kind: Schema.String }),
					),
					send(credential, "/v1/sessions?kind=trigger"),
				)
			const answered = (id: string) =>
				until("the trigger Session answers", async () => {
					const view = await json(
						SessionView,
						send(alice.session, "/v1/sessions/" + id),
					)
					return Session.status(view.session)._tag === "Completed"
						? view
						: undefined
				})
			const history = async (id: string) =>
				JSON.stringify(
					await (
						await send(alice.session, "/v1/sessions/" + id + "/history")
					).json(),
				)

			// A schedule that is not valid is refused.
			const wrong = await send(alice.session, "/v1/triggers", "POST", {
				prompt: "Check the build.",
				schedule: { cron: "every day" },
			})
			assert.equal(wrong.status, 400)

			// The schedule fires. The test moves its next time to now.
			const daily = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers", "POST", {
					prompt: "Check the build.",
					schedule: { cron: "0 9 * * *", timeZone: "Europe/Berlin" },
				}),
			)
			assert.equal(daily.actor, alice.identity.userId)
			assert.ok(daily.nextRunAt !== null && daily.nextRunAt > Date.now())
			await host.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					yield* sql`update openbot_triggers set next_run_at = 0 where id = ${daily.id}`
				}),
			)
			const scheduled = await until("a scheduled Session", async () => {
				const list = await sessions(alice.session)
				return list[0]
			})
			const view = await answered(scheduled.session.id)
			assert.match(await history(view.session.id), /Got: Check the build\./)
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
			assert.equal(hook.url, publicOrigin + "/v1/hooks/triggers/" + daily.id)
			const denied = await send(
				undefined,
				"/v1/hooks/triggers/" + daily.id,
				"POST",
				{ order: 42 },
				{ authorization: "Bearer wrong" },
			)
			assert.equal(denied.status, 401)
			const fired = await json(
				Schema.Struct({ session: Session.Id }),
				send(
					undefined,
					"/v1/hooks/triggers/" + daily.id,
					"POST",
					{ order: 42 },
					{ authorization: "Bearer " + hook.secret },
				),
			)
			await answered(fired.session)
			const text = await history(fired.session)
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
			assert.equal(disabled.nextRunAt, null)
			const off = await send(
				undefined,
				"/v1/hooks/triggers/" + daily.id,
				"POST",
				{},
				{ authorization: "Bearer " + hook.secret },
			)
			assert.equal(off.status, 401)

			// Bob cannot see the trigger of Alice, and a member cannot make shared triggers.
			assert.equal(
				(await send(bob.session, "/v1/triggers/" + daily.id)).status,
				404,
			)
			const shared = await send(bob.session, "/v1/triggers", "POST", {
				prompt: "Say hello.",
				shared: true,
			})
			assert.equal(shared.status, 403, await shared.clone().text())
			const team = await json(
				TriggersApi.Trigger,
				send(alice.session, "/v1/triggers", "POST", {
					prompt: "Say hello.",
					shared: true,
				}),
			)
			assert.deepEqual(team.owner, { _tag: "Organization" })
			const seen = await json(
				Schema.Array(TriggersApi.Trigger),
				send(bob.session, "/v1/triggers"),
			)
			assert.deepEqual(
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
			assert.equal(change.status, 403)
			assert.equal(
				(await send(alice.session, "/v1/triggers/" + team.id, "DELETE")).status,
				204,
			)
		} finally {
			await host.close()
		}
	},
)
