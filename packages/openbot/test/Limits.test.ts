// @effect-diagnostics strictEffectProvide:off
import { assert, describe, it } from "@effect/vitest"
import { BotsApi, type DelegationsApi } from "@openbot-build/api"
import { Chat } from "@openbot-build/core"
import { Effect, Layer, Option } from "effect"
import { Billing } from "../src/billing/Billing.ts"
import { Gate } from "../src/capabilities/Gate.ts"
import { Delegations, type Stored } from "../src/bots/Delegations.ts"
import * as Limits from "../src/bots/Limits.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
import { Settings } from "../src/settings/Settings.ts"

const top = Chat.Id.make("chat_top")
const task = Chat.Id.make("chat_task")
const below = Chat.Id.make("chat_below")

const work = (
	id: string,
	input: {
		readonly parent: Chat.Id
		readonly chat: Chat.Id
		readonly limits?: DelegationsApi.DelegationLimits
		readonly usage?: DelegationsApi.DelegationUsage
		readonly runningSince?: number
	},
): Stored => ({
	userId: "user_1",
	author: "user_1",
	chain: {
		organizationId: "org_1",
		userId: "user_1",
		bots: [BotsApi.BotId.make("bot_1")],
		chats: [],
	},
	...(input.runningSince === undefined
		? {}
		: { runningSince: input.runningSince }),
	delegation: {
		id,
		parent: { chat: input.parent },
		bot: BotsApi.BotId.make("bot_1"),
		chat: input.chat,
		status: "running",
		task: "Work.",
		result: null,
		...(input.limits === undefined ? {} : { limits: input.limits }),
		...(input.usage === undefined ? {} : { usage: input.usage }),
		createdAt: 100,
		updatedAt: 100,
	},
})

const child = work("dlg_below", { parent: task, chat: below })

/** Limits with records in memory. `spent` gets the Chats whose cost was asked for. */
const layer = (spent: Array<ReadonlyArray<string>>, timeLimitMs?: number) =>
	Limits.layer.pipe(
		Layer.provide([
			Layer.succeed(Delegations, {
				forChat: (_organizationId: string, chat: Chat.Id) =>
					Effect.succeed(chat === task ? [child] : []),
			} as unknown as Delegations["Service"]),
			Layer.succeed(Settings, {
				organization: () =>
					Effect.succeed({
						document: {
							...organizationDefaults,
							...(timeLimitMs === undefined
								? {}
								: { delegationTimeLimitMs: timeLimitMs }),
						},
						version: 1,
						updatedAt: 0,
					}),
			} as unknown as Settings["Service"]),
			Layer.succeed(Gate, {} as Gate["Service"]),
			Layer.succeed(Billing, {
				chatSpend: (_organizationId: string, chats: ReadonlyArray<string>) =>
					Effect.sync(() => {
						spent.push([...chats].sort())
						return 5_000
					}),
			} as unknown as Billing["Service"]),
		]),
	)

describe("The limits of delegated work", () => {
	it.effect(
		"count the cost of the work and of all the work it gave away",
		() => {
			const spent: Array<ReadonlyArray<string>> = []
			return Effect.gen(function* () {
				const limits = yield* Limits.Limits
				const stored = work("dlg_task", {
					parent: top,
					chat: task,
					limits: { timeMs: 60_000, budgetMicros: 5_000 },
					usage: { timeMs: 0, steps: 3, costMicros: 0 },
					runningSince: 1_000,
				})
				const check = yield* limits.check("org_1", stored, 2_000)
				assert.deepStrictEqual(check.reached, Option.some("budget"))
				assert.deepStrictEqual(check.usage, {
					timeMs: 1_000,
					steps: 3,
					costMicros: 5_000,
				})
				assert.deepStrictEqual(spent, [[below, task]])
				// When a decider let the work go on, only the cost after that counts.
				const renewed = Limits.resumed(
					Limits.paused(stored, { limit: "budget", now: 2_000 }),
					{ now: 3_000, renew: true, costMicros: 4_000 },
				)
				assert.deepStrictEqual(
					(yield* limits.check("org_1", renewed, 3_000)).reached,
					Option.none(),
				)
			}).pipe(Effect.provide(layer(spent)))
		},
	)

	it.effect(
		"stop the time in a pause, and give work without limits the time of the organization",
		() =>
			Effect.gen(function* () {
				const limits = yield* Limits.Limits
				const old = work("dlg_old", {
					parent: top,
					chat: task,
					runningSince: 0,
				})
				assert.deepStrictEqual(yield* limits.of("org_1", old), {
					timeMs: 120_000,
				})
				assert.deepStrictEqual(
					(yield* limits.check("org_1", old, 119_000)).reached,
					Option.none(),
				)
				assert.deepStrictEqual(
					(yield* limits.check("org_1", old, 120_000)).reached,
					Option.some("time"),
				)
				// The work pauses after 50 seconds. The pause does not count.
				const waiting = Limits.paused(old, { limit: "steps", now: 50_000 })
				assert.strictEqual(waiting.delegation.status, "paused")
				assert.strictEqual(waiting.delegation.usage?.timeMs, 50_000)
				const again = Limits.resumed(waiting, {
					now: 500_000,
					renew: false,
					costMicros: 0,
				})
				assert.deepStrictEqual(
					(yield* limits.check("org_1", again, 569_000)).reached,
					Option.none(),
				)
				assert.deepStrictEqual(
					(yield* limits.check("org_1", again, 570_000)).reached,
					Option.some("time"),
				)
			}).pipe(Effect.provide(layer([], 120_000))),
	)
})
