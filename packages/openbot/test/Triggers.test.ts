import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import {
	Authorization,
	ChatSummary,
	DelegationsApi,
	TriggersApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Effect,
	Option,
	pipe,
	Redacted,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { HttpClient, HttpClientRequest } from "effect/http"
import { dataNote } from "../src/triggers/Fire.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://triggers.example.com"
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

/** The model answers with the last user message, so the test can see what came in. */
const echo = LanguageModel.make({
	generateText: () =>
		Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
	streamText: ({ prompt }) => {
		const last = pipe(
			Arr.findLast(prompt.content, (message) => message.role === "user"),
			Option.map(textOf),
			Option.getOrElse(() => ""),
		)
		return Stream.make(
			Response.makePart("text-start", { id: "answer" }),
			Response.makePart("text-delta", { id: "answer", delta: "Got: " + last }),
			Response.makePart("text-end", { id: "answer" }),
			Response.makePart("finish", { reason: "stop", usage }),
		)
	},
})

/** Something that the test waits for did not happen in time. */
class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { label: Schema.String }) {
	override get message() {
		return "Timed out: " + this.label
	}
}

/**
 * Runs a check again and again, 25 milliseconds apart, until it gives a value.
 * It tries again at most 400 times, then fails with `TimedOut`.
 */
const until = <A, E, R>(
	label: string,
	check: Effect.Effect<Option.Option<A>, E, R>,
) =>
	check.pipe(
		Effect.repeat({
			until: Option.isSome,
			times: 400,
			schedule: Schedule.spaced("25 millis"),
		}),
		Effect.flatMap((found) =>
			Effect.fromOption(found, () => TimedOut.make({ label })),
		),
	)

/** The items of a Chat. The test reads them as JSON text and looks for words in it. */
const History = Schema.Struct({ items: Schema.Array(Item.Record) })
const encodeHistory = Schema.encodeEffect(Schema.fromJsonString(History))

/** Calls the API of the host as a browser, and the webhooks of triggers as another system. */
const client = Effect.fn("Triggers.client")(function* (host: BrowserHost.Host) {
	const address = yield* host.address
	const send = Caller.withCookie({ address, publicOrigin })
	/** Sends a call and reads its JSON answer with a schema. The answer must be 2xx. */
	const json = <S extends Schema.Constraint>(schema: S, call: Caller.Call) =>
		Effect.flatMap(call, Caller.json(schema))
	/** Posts a body to the webhook of a trigger with a secret and no session. */
	const webhook = (trigger: string, secret: string, payload: unknown) =>
		HttpClientRequest.post(address + "/v1/hooks/triggers/" + trigger, {
			headers: { origin: publicOrigin },
		}).pipe(
			HttpClientRequest.bearerToken(secret),
			HttpClientRequest.bodyJson(payload),
			Effect.flatMap(HttpClient.execute),
		)
	return { send, json, webhook }
})

// The hosts use real servers, so these tests run on the real clock.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a trigger gives its prompt to its Bot on a schedule and from a webhook, the result comes to the Chat of the actor, and only those who may use it",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* echo,
					triggerIntervalMs: 100,
				})
				const { send, json, webhook } = yield* client(host)
				const alice = yield* host.login("triggers-alice")
				const bob = yield* host.login("triggers-bob")
				yield* host.defaultBot(alice.session)
				yield* host.defaultBot(bob.session)
				const tasks = (credential: Redacted.Redacted<string>) =>
					json(
						Schema.Array(ChatSummary),
						send(credential, "/v1/chats?kind=task"),
					)
				const delegation = (id: string) =>
					json(
						DelegationsApi.Delegation,
						send(alice.session, "/v1/delegations/" + id),
					)
				const completed = (id: string) =>
					until(
						"the work of the trigger ends",
						Effect.map(
							delegation(id),
							Option.liftPredicate(
								(work: DelegationsApi.Delegation) =>
									work.status === "completed",
							),
						),
					)
				const history = (chat: string) =>
					json(
						History,
						send(alice.session, "/v1/chats/" + chat + "/items?limit=100"),
					).pipe(Effect.flatMap(encodeHistory))

				// A schedule that is not valid is refused.
				const wrong = yield* send(alice.session, "/v1/triggers", "POST", {
					prompt: "Check the build.",
					schedule: { cron: "every day" },
				})
				assert.strictEqual(wrong.status, 400)
				// A schedule that parses but never fires (February 30) is refused too.
				const never = yield* send(alice.session, "/v1/triggers", "POST", {
					prompt: "Check the build.",
					schedule: { cron: "0 0 30 2 *" },
				})
				assert.strictEqual(never.status, 400)

				// The schedule fires. The test moves its next time to now.
				const daily = yield* json(
					TriggersApi.Trigger,
					send(alice.session, "/v1/triggers", "POST", {
						prompt: "Check the build.",
						schedule: { cron: "0 9 * * *", timeZone: "Europe/Berlin" },
					}),
				)
				assert.strictEqual(daily.actor, alice.identity.userId)
				const created = yield* Clock.currentTimeMillis
				assert.ok(daily.nextRunAt !== null && daily.nextRunAt > created)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`update openbot_triggers set next_run_at = 0 where id = ${daily.id}`
					}),
				)
				const scheduled = yield* until(
					"a task of the schedule",
					Effect.map(tasks(alice.session), Arr.head),
				)
				assert.ok(scheduled.chat.parent !== null)
				const work = yield* completed(scheduled.chat.parent.delegation)
				assert.strictEqual(work.trigger, daily.id)
				assert.strictEqual(work.chat, scheduled.chat.id)
				const task = yield* history(scheduled.chat.id)
				// The task comes in as a note from OpenBot, and the model repeats it.
				assert.match(work.result ?? "", /^Got: .*Check the build\./s)
				assert.match(task, /Got: .*Check the build\./)
				// The result comes to the direct Chat of the actor with the Bot as a notice.
				const direct = work.parent.chat
				yield* until(
					"the notice of the result",
					Effect.map(
						history(direct),
						Option.liftPredicate(Str.includes(work.id)),
					),
				)
				const rest = yield* Messages.settled(
					(path, method, payload) => send(alice.session, path, method, payload),
					direct,
				)
				assert.strictEqual(rest.chat.kind, "direct")
				assert.strictEqual(rest.status, "Completed")
				const after = yield* json(
					TriggersApi.Trigger,
					send(alice.session, "/v1/triggers/" + daily.id),
				)
				assert.ok(after.lastFiredAt !== null)
				const fired = yield* Clock.currentTimeMillis
				assert.ok(after.nextRunAt !== null && after.nextRunAt > fired)

				// A webhook fires with its secret only. The body goes in as data.
				const hook = yield* json(
					TriggersApi.WebhookSecret,
					send(alice.session, "/v1/triggers/" + daily.id + "/webhook", "PUT"),
				)
				assert.strictEqual(
					hook.url,
					publicOrigin + "/v1/hooks/triggers/" + daily.id,
				)
				const denied = yield* webhook(daily.id, "wrong", { order: 42 })
				assert.strictEqual(denied.status, 401)
				const started = yield* json(
					Schema.Struct({ delegation: DelegationsApi.DelegationId }),
					webhook(daily.id, hook.secret, { order: 42 }),
				)
				const hooked = yield* completed(started.delegation)
				assert.ok(hooked.chat !== null)
				const text = yield* history(hooked.chat)
				assert.ok(Str.includes(dataNote)(text))
				assert.match(text, /order/)

				// A disabled trigger does not fire from its webhook.
				const disabled = yield* json(
					TriggersApi.Trigger,
					send(alice.session, "/v1/triggers/" + daily.id, "PATCH", {
						expected: after.revision + 1,
						enabled: false,
					}),
				)
				assert.strictEqual(disabled.nextRunAt, null)
				const off = yield* webhook(daily.id, hook.secret, {})
				assert.strictEqual(off.status, 401)

				// Bob cannot see the trigger of Alice, and a member cannot make shared triggers.
				assert.strictEqual(
					(yield* send(bob.session, "/v1/triggers/" + daily.id)).status,
					404,
				)
				const shared = yield* send(bob.session, "/v1/triggers", "POST", {
					prompt: "Say hello.",
					shared: true,
				})
				assert.strictEqual(shared.status, 403, yield* shared.text)
				const team = yield* json(
					TriggersApi.Trigger,
					send(alice.session, "/v1/triggers", "POST", {
						prompt: "Say hello.",
						shared: true,
					}),
				)
				assert.deepStrictEqual(team.owner, { _tag: "Organization" })
				const seen = yield* json(
					Schema.Array(TriggersApi.Trigger),
					send(bob.session, "/v1/triggers"),
				)
				assert.deepStrictEqual(
					Arr.map(seen, (trigger) => trigger.id),
					[team.id],
				)
				const change = yield* send(
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
					(yield* send(alice.session, "/v1/triggers/" + team.id, "DELETE"))
						.status,
					204,
				)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a deny rule on one trigger hides it from the list and from a read",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* echo,
				})
				const { send, json } = yield* client(host)
				const alice = yield* host.login("triggers-deny")
				yield* host.defaultBot(alice.session)
				const create = (prompt: string) =>
					json(
						TriggersApi.Trigger,
						send(alice.session, "/v1/triggers", "POST", { prompt }),
					)
				const open = yield* create("Open")
				const hidden = yield* create("Hidden")
				const listed = Effect.map(
					json(
						Schema.Array(TriggersApi.Trigger),
						send(alice.session, "/v1/triggers"),
					),
					(triggers) => Arr.map(triggers, (trigger) => trigger.id),
				)
				assert.sameMembers(yield* listed, [open.id, hidden.id])

				const changed = yield* send(
					alice.session,
					"/v1/organization/members/" +
						encodeURIComponent(alice.identity.userId),
					"PATCH",
					{
						policy: yield* Policies.json(function* (_) {
							yield* _.deny("read", Authorization.Trigger, {
								when: ($) => $.eq("id", hidden.id),
							})
						}),
					},
				)
				assert.strictEqual(changed.status, 200, yield* changed.text)
				// The list query has the condition of the policy, so the database
				// leaves out the trigger.
				assert.deepStrictEqual(yield* listed, [open.id])
				assert.strictEqual(
					(yield* send(alice.session, "/v1/triggers/" + hidden.id)).status,
					404,
				)
			}),
		{ timeout: 60000 },
	)
})
