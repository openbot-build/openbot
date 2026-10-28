import { assert, layer } from "@effect/vitest"
import {
	BotsApi,
	ChatCommandReceipt,
	ChatView,
	Settings,
} from "@openbot-build/api"
import { Config, Model, Provider, Turn } from "@openbot-build/core"
import { Effect, Schema } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"

const publicOrigin = "https://organization-model.example.com"
const selection = (reasoningEffort: "low" | "high") =>
	Config.Selection.make({
		provider: Provider.Id.make("fixture"),
		model: Model.Id.make("fixture-model"),
		reasoningEffort,
	})

layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "90 seconds",
})((it) => {
	it.effect(
		"organization defaults apply to the next Turn and preserve explicit Bot choices",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const call = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const send: Messages.Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				const path = "/v1/organization/settings"
				const initial = yield* Caller.read(
					Settings.OrganizationSettings,
					send(path, "GET"),
				)
				assert.isNull(initial.chatModel)
				assert.strictEqual((yield* call(bob.session, path)).status, 200)
				assert.strictEqual(
					(yield* call(bob.session, path, "PATCH", {
						expectedVersion: initial.version,
						chatModel: selection("low"),
					})).status,
					403,
				)
				assert.strictEqual(
					(yield* send(path, "PATCH", {
						expectedVersion: initial.version,
						chatModel: { provider: "missing", model: "missing" },
					})).status,
					400,
				)
				const low = yield* Caller.read(
					Settings.OrganizationSettings,
					send(path, "PATCH", {
						expectedVersion: initial.version,
						chatModel: selection("low"),
					}),
				)
				const botId = yield* host.defaultBot(alice.session)
				const created = yield* Caller.read(
					ChatView,
					send("/v1/chats", "POST", { botId, requestId: "inherit-model" }),
					201,
				)
				assert.isUndefined(created.chat.settings.model)
				const sendTurn = (key: string) =>
					Effect.gen(function* () {
						const receipt = yield* Caller.read(
							ChatCommandReceipt,
							send("/v1/chats/" + created.chat.id + "/messages", "POST", {
								commandKey: key,
								input: "Hello.",
							}),
							202,
						)
						yield* Messages.settled(send, created.chat.id)
						assert.ok(receipt.turn !== null)
						const turnId = receipt.turn
						const turn = yield* host.run(
							Effect.flatMap(Db.make, (db) =>
								StoredChats.persistence(db, ownerKey(alice.identity)).turn(
									created.chat.id,
									turnId,
								),
							),
						)
						assert.ok(turn._tag === "Some")
						return (yield* Schema.decodeUnknownEffect(Turn.Record)(turn.value))
							.settings.model
					})
				assert.deepStrictEqual(
					{ ...(yield* sendTurn("low")) },
					{ ...selection("low") },
				)
				const high = yield* Caller.read(
					Settings.OrganizationSettings,
					send(path, "PATCH", {
						expectedVersion: low.version,
						chatModel: selection("high"),
					}),
				)
				assert.strictEqual(
					(yield* send(path, "PATCH", {
						expectedVersion: low.version,
						chatModel: selection("low"),
					})).status,
					409,
				)
				assert.deepStrictEqual(
					{ ...(yield* sendTurn("high")) },
					{ ...selection("high") },
				)
				const bot = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots/" + botId, "GET"),
				)
				const override = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots/" + botId, "PATCH", {
						expected: bot.revision,
						model: selection("low"),
					}),
				)
				assert.deepStrictEqual(
					{ ...(yield* sendTurn("override")) },
					{ ...selection("low") },
				)
				yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots/" + botId, "PATCH", {
						expected: override.revision,
						model: null,
					}),
				)
				assert.deepStrictEqual(
					{ ...(yield* sendTurn("inherit-again")) },
					{ ...selection("high") },
				)
				assert.deepStrictEqual({ ...high.chatModel }, { ...selection("high") })
			}),
	)
})
