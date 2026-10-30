import { Policy } from "@nmnmcc/ability"
import { assert, layer } from "@effect/vitest"
import { ExecutionsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import {
	Authorization,
	Execution,
	Reminders as Domain,
	Tokens,
} from "@openbot-build/domain"
import { Array, Clock, Effect, Layer, Option, Schema, String } from "effect"
import * as Messages from "./Messages.ts"
import * as Wait from "./Wait.ts"
import { HttpClient } from "effect/http"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { Reminders } from "../src/plugins/work/Reminders.ts"
import * as Queries from "../src/plugins/work/ReminderQueries.ts"
import { Commands } from "../src/execution/Commands.ts"
import { botRecords } from "../src/database/Schema.ts"
import * as Db from "../src/database/Database.ts"

const publicOrigin = "https://reminders.example.test"
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"reminder pages enforce owner, organization and current Chat rights",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					bots: { memory: false },
				})
				const owner = yield* host.login("reminder-owner")
				const other = yield* host.login("reminder-other")
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const chat = Chat.Id.make("reminder-chat")
				yield* host.run(
					Effect.gen(function* () {
						const reminders = yield* Reminders
						for (const [id, userId, organizationId, status] of [
							[
								"a",
								owner.identity.userId,
								owner.identity.organizationId,
								"waiting",
							],
							[
								"b",
								owner.identity.userId,
								owner.identity.organizationId,
								"done",
							],
							[
								"c",
								owner.identity.userId,
								owner.identity.organizationId,
								"cancelled",
							],
							[
								"d",
								other.identity.userId,
								other.identity.organizationId,
								"waiting",
							],
							["e", owner.identity.userId, "foreign-organization", "waiting"],
						] as const) {
							yield* reminders.start(organizationId, {
								id,
								userId,
								author: userId,
								chat,
								turn: Turn.Id.make("turn-" + id),
								toolCallId: "call-" + id,
								note: "Private reminder " + id,
								dueAt: (yield* Clock.currentTimeMillis) + 1_800_000,
							})
							if (status !== "waiting")
								yield* reminders.change(organizationId, id, "waiting", status)
						}
						const db = yield* Db.make
						const saved = yield* db
							.select({ body: botRecords.body })
							.from(botRecords)
						assert.ok(
							Array.every(
								saved,
								(row) => !String.includes("Private reminder")(row.body),
							),
						)
					}),
				)
				const client = yield* HttpClient.HttpClient
				assert.equal((yield* client.get(address + "/v1/reminders")).status, 401)
				const first = yield* call(owner.session, "/v1/reminders?limit=2").pipe(
					Effect.flatMap(Caller.json(Domain.Page)),
				)
				assert.deepStrictEqual(
					Array.map(first.items, (row) => row.id),
					["a", "b"],
				)
				assert.equal(first.next, "b")
				assert.equal(first.items[1]!.status, "done")
				const second = yield* call(
					owner.session,
					"/v1/reminders?after=b&limit=2",
				).pipe(Effect.flatMap(Caller.json(Domain.Page)))
				assert.deepStrictEqual(
					Array.map(second.items, (row) => row.id),
					["c"],
				)
				assert.equal(second.next, null)
				const waiting = yield* call(
					owner.session,
					"/v1/reminders?status=waiting&chatId=reminder-chat",
				).pipe(Effect.flatMap(Caller.json(Domain.Page)))
				assert.deepStrictEqual(
					Array.map(waiting.items, (row) => row.id),
					["a"],
				)
				assert.equal(
					(yield* call(other.session, "/v1/reminders/a")).status,
					404,
				)
				assert.equal(
					(yield* call(owner.session, "/v1/reminders/e")).status,
					404,
				)
				assert.equal(
					(yield* call(owner.session, "/v1/reminders?limit=101")).status,
					400,
				)
				assert.equal(
					(yield* call(owner.session, "/v1/reminders/a/cancel", "POST", {
						commandKey: "legacy-cancel",
					})).status,
					409,
				)
				const token = yield* call(owner.session, "/v1/user/tokens", "POST", {
					name: "No Chat access",
					policy: yield* Schema.encodeEffect(Authorization.PolicyInput)(
						Authorization.emptyPolicy,
					),
				}).pipe(Effect.flatMap(Caller.json(Tokens.CreatedToken)))
				const limited = Caller.withToken(address)
				assert.equal(
					(yield* limited(token.secret, "/v1/reminders/a")).status,
					403,
				)
				const hidden = yield* limited(
					token.secret,
					"/v1/reminders?limit=2",
				).pipe(Effect.flatMap(Caller.json(Domain.Page)))
				assert.deepStrictEqual(hidden.items, [])
				assert.equal(hidden.next, "b")
				const remaining = yield* limited(
					token.secret,
					"/v1/reminders?limit=2&after=b",
				).pipe(Effect.flatMap(Caller.json(Domain.Page)))
				assert.deepStrictEqual(remaining.items, [])
				assert.equal(remaining.next, null)
				// Cancellation delegates the saved execution ID and command key without a second scheduler.
				const executionId = Execution.Id.make("saved-reminder-execution")
				yield* host.run(
					Effect.gen(function* () {
						yield* (yield* Reminders).start(owner.identity.organizationId, {
							id: "with-execution",
							executionId,
							userId: owner.identity.userId,
							author: owner.identity.userId,
							chat,
							turn: Turn.Id.make("turn"),
							toolCallId: "call",
							note: "Later",
							dueAt: (yield* Clock.currentTimeMillis) + 1_800_000,
						})
					}),
				)
				const commandKey = Execution.CommandKey.make("cancel-owned-reminder")
				const queries = yield* host.run(
					Queries.make.pipe(
						Effect.provide(
							Layer.mock(Commands, {
								cancel: (id, caller, key) => {
									assert.equal(id, executionId)
									assert.equal(caller.userId, owner.identity.userId)
									assert.equal(key, commandKey)
									return Effect.succeed({
										executionId,
										commandKey,
										sequence: 1,
									})
								},
							}),
						),
					),
				)
				const receipt = yield* queries.cancel(
					owner.identity,
					"with-execution",
					commandKey,
				)
				assert.equal(receipt.executionId, executionId)
				const denied = yield* queries
					.cancel(other.identity, "with-execution", commandKey)
					.pipe(Effect.flip)
				assert.equal(denied._tag, "ReminderNotFound")
				const after = yield* host.run(
					Effect.flatMap(Reminders, (reminders) =>
						reminders.find(owner.identity.organizationId, "with-execution"),
					),
				)
				assert.equal(Option.getOrThrow(after).status, "waiting")
			}).pipe(Effect.scoped),
	)
	it.effect(
		"a visible reminder cancels through its native execution and stays cancelled after restart",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					bots: { memory: false },
				})
				const owner = yield* host.login("native-reminder-owner")
				const bot = yield* host.defaultBot(owner.session)
				const request: Messages.Send = (path, method, payload) =>
					host.address.pipe(
						Effect.flatMap((address) =>
							Caller.withCookie({ address, publicOrigin })(
								owner.session,
								path,
								method,
								payload,
							),
						),
					)
				const sent = yield* Messages.message(
					request,
					bot,
					"Remind me in thirty minutes",
				)
				yield* Messages.settled(request, sent.chat)
				const read = request("/v1/reminders", "GET").pipe(
					Effect.flatMap(Caller.json(Domain.Page)),
				)
				const page = yield* Wait.untilTrue(
					"saved native reminder",
					read,
					(page) => page.items.length === 1,
				)
				const reminder = page.items[0]!
				assert.equal(reminder.chatId, sent.chat)
				assert.equal(reminder.status, "waiting")
				assert.ok(reminder.executionId !== null)
				const token = yield* request("/v1/user/tokens", "POST", {
					name: "Read reminders",
					policy: yield* Schema.encodeEffect(Authorization.PolicyInput)(
						Policy.define(Authorization.OpenBot)(function* (_) {
							yield* _.allow("read", "Chat")
						}),
					),
				}).pipe(Effect.flatMap(Caller.json(Tokens.CreatedToken)))
				const limited = Caller.withToken(yield* host.address)
				const visible = yield* limited(
					token.secret,
					"/v1/reminders/" + reminder.id,
				).pipe(Effect.flatMap(Caller.json(Domain.Reminder)))
				assert.equal(visible.id, reminder.id)
				assert.equal(
					(yield* limited(
						token.secret,
						"/v1/reminders/" + reminder.id + "/cancel",
						"POST",
						{ commandKey: "denied-reminder-cancel" },
					)).status,
					403,
				)
				const cancel = request(
					"/v1/reminders/" + reminder.id + "/cancel",
					"POST",
					{ commandKey: "native-reminder-cancel" },
				).pipe(Effect.flatMap(Caller.json(Execution.Receipt)))
				const receipt = yield* cancel
				assert.equal(receipt.executionId, reminder.executionId)
				yield* Wait.untilTrue(
					"cancelled reminder workflow",
					request("/v1/executions/" + reminder.executionId, "GET").pipe(
						Effect.flatMap(Caller.json(ExecutionsApi.Execution.Record)),
					),
					(value) => value.status === "cancelled",
				)
				assert.equal((yield* read).items[0]!.status, "cancelled")
				assert.deepEqual(yield* cancel, receipt)
				yield* host.restart
				assert.equal((yield* read).items[0]!.status, "cancelled")
				assert.equal((yield* Messages.view(request, sent.chat)).inbox, 0)
			}).pipe(Effect.scoped),
	)
})
