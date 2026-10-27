import { assert, describe, it } from "@effect/vitest"
import {
	BotsApi,
	DelegationsApi,
	Settings as SettingsApi,
} from "@openbot-build/api"
import { Chat } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Option,
	Order,
	Ref,
	Schema,
} from "effect"
import { Billing } from "../src/billing/Billing.ts"
import { Gate } from "../src/capabilities/Gate.ts"
import { Delegations, type Stored } from "../src/bots/Delegations.ts"
import * as Limits from "../src/bots/Limits.ts"
import {
	delegationTimeLimitOf,
	organizationDefaults,
} from "../src/settings/Documents.ts"
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
		id: DelegationsApi.DelegationId.make(id),
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

/**
 * Limits with records in memory. The fakes have only the methods that the
 * limits call.
 */
const layer = (
	options: {
		readonly timeLimitMs?: number
		readonly organization?: Settings["Service"]["organization"]
		readonly chatSpend?: Billing["Service"]["chatSpend"]
		readonly change?: Delegations["Service"]["change"]
		readonly check?: Gate["Service"]["check"]
	} = {},
) =>
	Limits.layer.pipe(
		Layer.provide([
			Layer.mock(Delegations, {
				forChat: (_organizationId, chat) =>
					Effect.succeed(chat === task ? [child] : []),
				...(options.change === undefined ? {} : { change: options.change }),
			}),
			Layer.mock(Settings, {
				organization:
					options.organization ??
					(() =>
						Effect.succeed({
							document: {
								...organizationDefaults,
								...(options.timeLimitMs === undefined
									? {}
									: { delegationTimeLimitMs: options.timeLimitMs }),
							},
							version: 1,
							updatedAt: 0,
						})),
			}),
			Layer.mock(
				Gate,
				options.check === undefined ? {} : { check: options.check },
			),
			Layer.mock(Billing, {
				chatSpend: options.chatSpend ?? (() => Effect.succeed(5_000)),
			}),
		]),
	)

interface Line {
	readonly level: string
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
}

/** Keeps every log line of a test in place of the normal output. */
const collect = () => {
	let lines: ReadonlyArray<Line> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			lines = [
				...lines,
				{ level: log.logLevel, message: log.message, cause: log.cause },
			]
		}),
	])
	return { layer, lines: () => lines }
}

describe("The limits of delegated work", () => {
	it.effect("count the cost of the work and of all the work it gave away", () =>
		Effect.gen(function* () {
			const spent = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
			const limits = yield* Limits.Limits.pipe(
				Effect.provide(
					layer({
						chatSpend: (_organizationId, chats) =>
							Ref.update(spent, Arr.append(Arr.sort(chats, Order.String))).pipe(
								Effect.as(5_000),
							),
					}),
				),
			)
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
			assert.deepStrictEqual(yield* Ref.get(spent), [[below, task]])
			// When a decider let the work go on, only the cost after that counts.
			const renewed = Limits.resumed(
				Limits.paused(stored, { limit: "budget", now: 2_000 }),
				{ now: 3_000, renew: true, costMicros: 4_000 },
			)
			assert.deepStrictEqual(
				(yield* limits.check("org_1", renewed, 3_000)).reached,
				Option.none(),
			)
		}),
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
			}).pipe(Effect.provide(layer({ timeLimitMs: 120_000 }))),
	)

	it.effect(
		"give work the default time when the settings cannot be read, and log why",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const limits = yield* Limits.Limits
				const old = work("dlg_old", { parent: top, chat: task })
				assert.deepStrictEqual(yield* limits.of("org_1", old), {
					timeMs: delegationTimeLimitOf({}),
				})
				const lines = logs.lines()
				assert.strictEqual(lines.length, 1)
				const [line] = lines
				assert.ok(line !== undefined && Arr.isArray(line.message))
				assert.strictEqual(line.level, "Warn")
				const [message, error] = line.message
				assert.strictEqual(
					message,
					"The time limit of the organization could not be read, so work uses the default one",
				)
				assert.ok(Schema.is(SettingsApi.SettingsUnavailable)(error))
			}).pipe(
				Effect.provide(
					Layer.merge(
						layer({
							organization: () =>
								Effect.fail(SettingsApi.SettingsUnavailable.make({})),
						}),
						logs.layer,
					),
				),
			)
		},
	)

	it.effect(
		"give the last known cost when the cost cannot be read, but stay stopped when stopped",
		() => {
			const logs = collect()
			const stored = work("dlg_task", {
				parent: top,
				chat: task,
				usage: { timeMs: 0, steps: 0, costMicros: 1_234 },
			})
			return Effect.gen(function* () {
				const failing = yield* Limits.Limits.pipe(
					Effect.flatMap((limits) => limits.cost("org_1", stored)),
					Effect.provide(
						layer({
							chatSpend: () => Effect.die("The database is down."),
						}),
					),
				)
				assert.strictEqual(failing, 1_234)
				const [line] = logs.lines()
				assert.ok(line !== undefined)
				assert.deepStrictEqual(
					[line.level, line.message],
					["Warn", ["The cost of delegated work could not be read"]],
				)
				assert.ok(Cause.hasDies(line.cause))
				const stopped = yield* Limits.Limits.pipe(
					Effect.flatMap((limits) => limits.cost("org_1", stored)),
					Effect.provide(layer({ chatSpend: () => Effect.interrupt })),
					Effect.exit,
				)
				assert.ok(Exit.hasInterrupts(stopped))
				// A stop is not a failure, so nothing more is logged.
				assert.strictEqual(logs.lines().length, 1)
			}).pipe(Effect.provide(logs.layer))
		},
	)

	it.effect(
		"let the work run again when its pause stops before the Gate answers",
		() =>
			Effect.gen(function* () {
				const record = yield* Ref.make(
					work("dlg_task", {
						parent: top,
						chat: task,
						limits: { timeMs: 60_000, steps: 3 },
						usage: { timeMs: 0, steps: 3, costMicros: 700 },
						runningSince: 0,
					}),
				)
				const asked = yield* Deferred.make<void>()
				/** One record in memory, changed the way the store changes it. */
				const change: Delegations["Service"]["change"] = (
					_organizationId,
					_id,
					expected,
					update,
					when,
				) =>
					Ref.modify(record, (current) => {
						if (
							!Arr.contains(expected, current.delegation.status) ||
							(when !== undefined && !when(current))
						)
							return [Option.none(), current]
						const next = update(current)
						return [Option.some(next), next]
					})
				const limits = yield* Limits.Limits.pipe(
					Effect.provide(
						layer({
							change,
							// The Gate waits, as for a judge model that takes long.
							check: () =>
								Deferred.succeed(asked, undefined).pipe(
									Effect.andThen(Effect.never),
								),
						}),
					),
				)
				const pausing = yield* limits
					.pause("org_1", "dlg_task", "steps")
					.pipe(Effect.forkChild)
				yield* Deferred.await(asked)
				assert.strictEqual((yield* Ref.get(record)).delegation.status, "paused")
				// A person stops the Turn while the Gate still thinks.
				yield* Fiber.interrupt(pausing)
				const after = yield* Ref.get(record)
				assert.strictEqual(after.delegation.status, "running")
				assert.strictEqual(after.delegation.pause, undefined)
				assert.deepStrictEqual(after.delegation.usage, {
					timeMs: 0,
					steps: 3,
					costMicros: 700,
				})
				// The limits stay as they were, so the next check pauses the work again.
				assert.deepStrictEqual(
					(yield* limits.check("org_1", after, 0)).reached,
					Option.some("steps"),
				)
			}),
	)
})
