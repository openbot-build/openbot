import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Bot, Chat, ChatStore, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	Layer,
	Predicate,
	Option,
	Ref,
	Record as Rec,
	Stream,
} from "effect"
import { Prompt, type Tool, Toolkit } from "effect/ai"
import { Answer, Gate } from "../src/capabilities/Gate.ts"
import { Work } from "../src/capabilities/Work.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import { OpenWork } from "../src/chats/OpenWork.ts"
import { ReminderCommands } from "../src/plugins/work/ReminderCommands.ts"
import { Execution } from "@openbot-build/domain"
import * as ToolApprovals from "./ToolApprovals.ts"
import { Records } from "../src/errors/Records.ts"
import * as WorkTools from "../src/plugins/work/WorkTools.ts"
import { Settings } from "../src/settings/Settings.ts"
import { bot } from "./BotFixture.ts"

const chat = Chat.Id.make("chat_1")
const turn = Turn.Id.make("turn_1")
const chain = {
	organizationId: "org_1",
	userId: "user_1",
	bots: [bot.id],
	chats: [],
}

/**
 * A direct Chat in plan mode. The plugin reads only the mode, the turn, the todo
 * list and the host state, so the test gives only those.
 */
const view = {
	chat: {
		id: chat,
		settings: { mode: "plan" },
		inbox: [],
		business: {
			[ChatHost.chatHostId]: { bot: bot.id, kind: "direct", chain },
		},
	},
	state: {},
} as unknown as Chat.View<ChatHost.Values>

/**
 * The work plugin and Approvals with fakes. The Gate allows every check, so only a
 * remembered Deny can stop a call.
 */
const fence = {
	namespace: "org_1:user_1",
	id: Execution.Id.make("turn-execution"),
	generation: Execution.Generation.make(1),
}
const pluginWith = (
	checks: Ref.Ref<ReadonlyArray<string>>,
	reminders: Layer.PartialEffectful<ReminderCommands["Service"]> = {},
) =>
	Layer.effect(WorkTools.WorkTools, WorkTools.durable(fence)).pipe(
		Layer.provideMerge(
			ToolApprovals.layer((attempt) =>
				Ref.update(checks, Arr.append(attempt.capability.action)).pipe(
					Effect.as(Answer.Allow()),
				),
			),
		),
		Layer.provide([
			Layer.mock(ReminderCommands, {
				start: () => Effect.die("No reminder is expected."),
				...reminders,
			}),
			Layer.mock(Settings, {}),
			Layer.mock(Records, {}),
			Layer.mock(OpenWork, {}),
			NodeCrypto.layer,
		]),
	)

/** The Work of the test Bot in its plan Turn. */
const makeWork = Effect.succeed(
	Work.of({
		identity: {
			owner: { organizationId: "org_1", userId: "user_1" },
			actor: { kind: "member", organizationId: "org_1", userId: "user_1" },
			botId: bot.id,
		},
		namespace: "org_1:user_1",
		bot,
		chain,
		deciders: [bot.id],
		chat,
		turn,
	}),
)

/** Runs `use` in the plan Turn with the tools of the plugin. */
const inTurn = <A, E>(
	work: Work["Service"],
	store: Pick<ChatStore.Store<ChatHost.Values>, "modifyEffect">,
	use: (
		toolkit: Toolkit.Any,
	) => Effect.Effect<A, E, Work | Chat.Approvals | Gate>,
) =>
	Effect.gen(function* () {
		const registration = yield* (yield* WorkTools.WorkTools).register({
			read: () => Effect.succeed(view),
			store,
		})
		const tools: WorkTools.Tools = registration.tools
		return yield* use(Toolkit.make(...Rec.values(tools))).pipe(
			Effect.provideContext(registration.handlers),
		)
	}).pipe(
		Effect.provideService(Work, work),
		Effect.provideService(Bot.Context, {
			options: { prompt: [] },
			at: Effect.succeed(Chat.position(view.chat)),
			turn: Effect.succeed(turn),
			step: Effect.succeed(0),
			history: Effect.succeed(Prompt.empty),
		}),
		Effect.scoped,
	)

/** Asks whether a call of the tool needs a decision, as the runtime does. */
const needsApproval = (tool: Tool.Any, params: unknown, toolCallId: string) => {
	const check = tool.needsApproval
	if (!Predicate.isFunction(check)) return Effect.succeed(check === true)
	const result = check(params, { toolCallId, messages: [] })
	return Effect.isEffect(result) ? result : Effect.succeed(result)
}

const plan = {
	items: [{ id: "1", content: "Read the files", status: "pending" }],
	summary: "Read the files first.",
}

describe("plan tool", () => {
	it.effect(
		"a plan whose todo list cannot be saved ends with a Deny, not a generic check",
		() =>
			Effect.gen(function* () {
				const checks = yield* Ref.make<ReadonlyArray<string>>([])
				const work = yield* makeWork
				const failing = {
					modifyEffect: () =>
						Effect.fail(
							ChatStore.ChatStoreError.make({
								reason: "storage-failed",
								message: "The store is down.",
							}),
						),
				}
				const { asks, decision } = yield* inTurn(work, failing, (toolkit) =>
					Effect.gen(function* () {
						const tool = toolkit.tools[WorkTools.names.submitPlan]
						if (tool === undefined) return yield* Effect.die("No plan tool")
						const asks = yield* needsApproval(tool, plan, "call_1")
						const decision = yield* (yield* Chat.Approvals).decide({
							chat,
							turn,
							approvalId: "approval_1",
							toolCall: Prompt.toolCallPart({
								id: "call_1",
								name: WorkTools.names.submitPlan,
								params: plan,
								providerExecuted: false,
							}),
						})
						return { asks, decision }
					}),
				).pipe(Effect.provide(pluginWith(checks)))
				assert.isTrue(asks)
				assert.deepStrictEqual(
					decision,
					Chat.Decision.Deny({ reason: "OpenBot could not check this plan." }),
				)
				assert.deepStrictEqual(yield* Ref.get(checks), [])
			}),
	)

	it.effect("a plan with a wrong list does not wait for a decision", () =>
		Effect.gen(function* () {
			const checks = yield* Ref.make<ReadonlyArray<string>>([])
			const work = yield* makeWork
			const unused = { modifyEffect: () => Effect.die("No save is expected.") }
			const { asks, answer } = yield* inTurn(work, unused, (toolkit) =>
				Effect.gen(function* () {
					const tool = toolkit.tools[WorkTools.names.submitPlan]
					if (tool === undefined) return yield* Effect.die("No plan tool")
					return {
						asks: yield* needsApproval(tool, { items: "none" }, "call_1"),
						answer: yield* (yield* Gate).answer("call_1"),
					}
				}),
			).pipe(Effect.provide(pluginWith(checks)))
			assert.isFalse(asks)
			assert.isTrue(Option.isNone(answer))
			assert.deepStrictEqual(yield* Ref.get(checks), [])
		}),
	)
})

describe("reminder tool", () => {
	it.effect("a reminder past the range of a date is not kept", () =>
		Effect.gen(function* () {
			const checks = yield* Ref.make<ReadonlyArray<string>>([])
			const work = yield* makeWork
			const unused = { modifyEffect: () => Effect.die("No save is expected.") }
			const results = yield* inTurn(work, unused, (toolkit) =>
				// The plugin gives the handlers of its tools to the rest of the Turn, so the
				// toolkit finds them there. Its type cannot say so.
				(
					toolkit as unknown as Effect.Effect<
						Toolkit.WithHandler<WorkTools.Tools>
					>
				).pipe(
					Effect.flatMap((handled) =>
						handled.handle(
							WorkTools.names.remind,
							{ seconds: 1e13, note: "Look again." },
							"call_1",
						),
					),
					Effect.flatMap(Stream.runCollect),
				),
			).pipe(Effect.provide(pluginWith(checks)))
			assert.deepStrictEqual(
				Arr.map(results, (each) => each.result),
				[{ error: "seconds is too large." }],
			)
		}),
	)
})
