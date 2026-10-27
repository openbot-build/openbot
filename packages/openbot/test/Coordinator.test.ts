import { assert, describe, it } from "@effect/vitest"
import {
	BotsApi,
	DelegationsApi,
	ChatConflict,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Chat, Item, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	Logger,
	Option,
	Ref,
} from "effect"
import { Prompt } from "effect/ai"
import { Invocations } from "../src/apps/Invocations.ts"
import * as Coordinator from "../src/bots/Coordinator.ts"
import type { Stored } from "../src/bots/Delegations.ts"

const limits = { timeMs: 3_000 }

const work = (
	input: {
		readonly status?: "running" | "paused"
		readonly runningSince?: number
		readonly usage?: number
		readonly window?: number
	} = {},
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
	...(input.window === undefined
		? {}
		: { window: { timeMs: input.window, steps: 0, costMicros: 0 } }),
	delegation: {
		id: DelegationsApi.DelegationId.make("dlg_1"),
		parent: { chat: Chat.Id.make("chat_parent") },
		bot: BotsApi.BotId.make("bot_1"),
		chat: Chat.Id.make("chat_task"),
		status: input.status ?? "running",
		task: "Work.",
		result: null,
		limits,
		...(input.usage === undefined
			? {}
			: { usage: { timeMs: input.usage, steps: 0, costMicros: 0 } }),
		createdAt: 0,
		updatedAt: 0,
	},
})

/**
 * A clock that moves only when something sleeps, so a test needs no real time.
 * Its first sleep wakes one millisecond early by the clock, as a Node timer can.
 */
const earlyClock = (start: number): Clock.Clock => {
	let now = start
	let early = 1
	const nanos = () => BigInt(now) * 1_000_000n
	return {
		currentTimeMillisUnsafe: () => now,
		currentTimeMillis: Effect.sync(() => now),
		currentTimeNanosUnsafe: nanos,
		currentTimeNanos: Effect.sync(nanos),
		monotonicTimeNanosUnsafe: nanos,
		monotonicTimeNanos: Effect.sync(nanos),
		sleep: (duration) =>
			Effect.sync(() => {
				now += Math.max(0, Duration.toMillis(duration) - early)
				early = 0
			}),
	}
}

/** Gives the values one by one, one for each read, and then none. */
const reads = (values: ReadonlyArray<Stored>) =>
	Effect.map(Ref.make(values), (rest) =>
		Ref.modify(rest, (list) => [Arr.head(list), Arr.drop(list, 1)] as const),
	)

/**
 * Runs a watch on its own clock that starts at `start`, and gives the times at
 * which the watch paused the work.
 */
const watch = (find: Effect.Effect<Option.Option<Stored>>, start: number) =>
	Effect.gen(function* () {
		const pauses = yield* Ref.make<ReadonlyArray<number>>([])
		yield* Coordinator.watchTimeLimit({
			find,
			limitsOf: () => Effect.succeed(limits),
			pause: () =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					Ref.update(pauses, Arr.append(now)),
				),
		})
		return yield* Ref.get(pauses)
	}).pipe(Effect.provideService(Clock.Clock, earlyClock(start)))

describe("The time limit of delegated work", () => {
	it.effect(
		"a watch that wakes before the time limit sleeps again, and then pauses the work",
		() =>
			Effect.gen(function* () {
				const pauses = yield* watch(
					Effect.succeedSome(work({ runningSince: 1_000 })),
					1_000,
				)
				assert.deepStrictEqual(pauses, [4_000])
			}),
	)

	it.effect(
		"a watch ends without a pause when the work stops running, or runs again after a pause",
		() =>
			Effect.gen(function* () {
				const stopped = yield* watch(
					yield* reads([
						work({ runningSince: 1_000 }),
						work({ status: "paused", usage: 2_000 }),
					]),
					1_000,
				)
				assert.deepStrictEqual(stopped, [])
				// The step that let the work go on watches the new run.
				const again = yield* watch(
					yield* reads([
						work({ runningSince: 1_000 }),
						work({ runningSince: 3_000, usage: 2_000, window: 2_000 }),
					]),
					1_000,
				)
				assert.deepStrictEqual(again, [])
			}),
	)

	it.effect("work that is over its time pauses at once", () =>
		Effect.gen(function* () {
			const pauses = yield* watch(
				Effect.succeedSome(work({ runningSince: 0 })),
				5_000,
			)
			assert.deepStrictEqual(pauses, [5_000])
		}),
	)

	it("the time of a pause and the time before the limits started again do not count", () => {
		// The work ran for 2 seconds before a pause. It has 1 second more.
		assert.strictEqual(
			Coordinator.timeLimitAt(
				work({ runningSince: 50_000, usage: 2_000 }),
				50_000,
				limits,
			),
			51_000,
		)
		// The work ran for 10 seconds, but its limits started again after 9 of them.
		// So only 1 second counts, and it has 2 seconds more.
		assert.strictEqual(
			Coordinator.timeLimitAt(
				work({ runningSince: 50_000, usage: 10_000, window: 9_000 }),
				50_000,
				limits,
			),
			52_000,
		)
	})
})

/** Invocations whose `approve` answers with `answer`. The fake has only that method. */
const invocations = (
	answer: ReturnType<(typeof Invocations.Service)["approve"]>,
): typeof Invocations.Service => ({
	...({} as typeof Invocations.Service),
	approve: () => answer,
})

const position = {
	owner: "org_1:user_1",
	chat: Chat.Id.make("chat_1"),
	turn: Turn.Id.make("turn_1"),
}

describe("The decision about an App call", () => {
	it.effect(
		"counts only when it is saved, and logs every failure that does not say the call changed",
		() =>
			Effect.gen(function* () {
				let levels: ReadonlyArray<string> = []
				const logger = Logger.layer([
					Logger.make((log) => {
						levels = [...levels, log.logLevel]
					}),
				])
				const decide = (answer: Parameters<typeof invocations>[0]) =>
					Coordinator.decideCall(
						invocations(answer),
						position,
						"call_1:0",
						true,
					).pipe(Effect.provide(logger))
				assert.strictEqual(yield* decide(Effect.void), "Saved")
				// A change of the connection is the normal reason, so it is not logged.
				assert.strictEqual(
					yield* decide(
						Effect.fail(ChatConflict.make({ message: "It changed." })),
					),
					"Changed",
				)
				assert.deepStrictEqual(levels, [])
				assert.strictEqual(
					yield* decide(
						Effect.fail(ExperienceNotFound.make({ id: "App operation" })),
					),
					"Changed",
				)
				// A storage failure is not a change of the connection.
				assert.strictEqual(
					yield* decide(Effect.fail(ExperienceStorageUnavailable.make({}))),
					"Unavailable",
				)
				assert.deepStrictEqual(levels, ["Warn", "Warn"])
			}),
	)
})

/** A task Chat, with the given inbox and current Turn. */
const taskChat = (input: {
	readonly inbox?: ReadonlyArray<Chat.InboxEntry>
	readonly turnStartedAt?: number
}): Chat.Ref => ({
	id: Chat.Id.make("chat_task"),
	revision: Chat.Revision.make(1),
	settings: { mode: "build" },
	inbox: input.inbox ?? [],
	...(input.turnStartedAt === undefined
		? {}
		: {
				turn: {
					id: Turn.Id.make("turn_1"),
					chat: Chat.Id.make("chat_task"),
					settings: { mode: "build" },
					status: { _tag: "Running" },
					steps: 0,
					input: [],
					items: [],
					startedAt: input.turnStartedAt,
				},
			}),
	seq: Item.Seq.make(0),
	business: {},
	createdAt: 0,
})

/** An inbox entry from OpenBot with a notice. */
const waiting = (notice: Item.Notice): Chat.InboxEntry => ({
	id: Item.Id.make("item_" + notice.kind + "_" + (notice.ref ?? "")),
	content: Prompt.make("Work."),
	kind: "message",
	notice,
})

describe("The task of delegated work after a start that stopped half way", () => {
	it("a task in the inbox, or a Turn after the claim, means the task reached the Chat", () => {
		assert.deepStrictEqual(
			Coordinator.taskInChat(
				taskChat({ inbox: [waiting({ kind: "task", ref: "dlg_1" })] }),
				"dlg_1",
				1_000,
			),
			Option.some(true),
		)
		assert.deepStrictEqual(
			Coordinator.taskInChat(
				taskChat({ turnStartedAt: 1_000 }),
				"dlg_1",
				1_000,
			),
			Option.some(true),
		)
	})

	it("a task Chat without a Turn and without the task never got the task", () => {
		// The task of other work does not count.
		assert.deepStrictEqual(
			Coordinator.taskInChat(
				taskChat({ inbox: [waiting({ kind: "task", ref: "dlg_2" })] }),
				"dlg_1",
				1_000,
			),
			Option.some(false),
		)
	})

	it("a Turn from before the claim, such as of earlier work in the same Chat, needs a read of the log", () => {
		assert.deepStrictEqual(
			Coordinator.taskInChat(taskChat({ turnStartedAt: 999 }), "dlg_1", 1_000),
			Option.none(),
		)
	})
})
