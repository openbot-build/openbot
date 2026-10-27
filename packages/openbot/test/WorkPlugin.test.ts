import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Bot, Chat, ChatStore, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Predicate,
	Ref,
	Stream,
} from "effect"
import { Prompt, type Tool, Toolkit } from "effect/ai"
import { Signals } from "../src/bots/Signals.ts"
import * as Approvals from "../src/capabilities/Approvals.ts"
import { Answer, Gate } from "../src/capabilities/Gate.ts"
import { Requests } from "../src/capabilities/Requests.ts"
import { Work } from "../src/capabilities/Work.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import { OpenWork } from "../src/chats/OpenWork.ts"
import { Reminders } from "../src/plugins/work/Reminders.ts"
import * as WorkPlugin from "../src/plugins/work/WorkPlugin.ts"
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
const pluginWith = (checks: Ref.Ref<ReadonlyArray<string>>) =>
	Layer.merge(
		WorkPlugin.layer,
		Approvals.layer.pipe(
			Layer.provide(Layer.succeed(Requests, {} as Requests["Service"])),
		),
	).pipe(
		Layer.provide([
			Layer.succeed(Gate, {
				...({} as Gate["Service"]),
				check: (attempt) =>
					Ref.update(checks, Arr.append(attempt.capability.action)).pipe(
						Effect.as(Answer.Allow()),
					),
			}),
			Layer.succeed(Reminders, {
				...({} as Reminders["Service"]),
				start: () => Effect.die("No reminder is expected."),
			}),
			Layer.succeed(Settings, {} as Settings["Service"]),
			Layer.succeed(OpenWork, {} as OpenWork["Service"]),
			Layer.succeed(Signals, {} as Signals["Service"]),
			NodeCrypto.layer,
		]),
	)

/** The Work of the test Bot in its plan Turn. */
const makeWork = Effect.map(
	Ref.make(HashMap.empty<string, Answer>()),
	(answers) =>
		Work.of({
			caller: { kind: "member", organizationId: "org_1", userId: "user_1" },
			namespace: "org_1:user_1",
			bot,
			chain,
			deciders: [bot.id],
			chat,
			turn,
			checks: answers,
		}),
)

/** Runs `use` in the plan Turn with the tools of the plugin. */
const inTurn = <A, E>(
	work: Work["Service"],
	store: Pick<ChatStore.Store<ChatHost.Values>, "modifyEffect">,
	use: (toolkit: Toolkit.Any) => Effect.Effect<A, E, Work | Chat.Approvals>,
) =>
	Effect.gen(function* () {
		const plugin = (yield* WorkPlugin.WorkPlugin).forOwner({
			read: () => Effect.succeed(view),
			store,
		})
		const middleware = yield* plugin.middleware
		const out = yield* Ref.make(Option.none<A>())
		yield* middleware<never, never, E, Work | Chat.Approvals>(
			(options) =>
				Stream.fromEffect(
					options.toolkit.pipe(
						Effect.flatMap(use),
						Effect.flatMap((value) => Ref.set(out, Option.some(value))),
					),
				).pipe(Stream.drain),
			{
				prompt: [],
				instructions: Prompt.empty,
				toolkit: Effect.succeed(Toolkit.empty),
			},
		).pipe(
			Stream.runDrain,
			Effect.provideService(Work, work),
			Effect.provideService(Bot.Context, {
				...({} as Bot.Context["Service"]),
				at: Effect.succeed(Chat.position(view.chat)),
				turn: Effect.succeed(turn),
			}),
		)
		return yield* Effect.flatMap(Ref.get(out), Effect.fromOption)
	}).pipe(Effect.scoped)

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
						const tool = toolkit.tools[WorkPlugin.names.submitPlan]
						if (tool === undefined) return yield* Effect.die("No plan tool")
						const asks = yield* needsApproval(tool, plan, "call_1")
						const decision = yield* (yield* Chat.Approvals).decide({
							chat,
							turn,
							approvalId: "approval_1",
							toolCall: Prompt.toolCallPart({
								id: "call_1",
								name: WorkPlugin.names.submitPlan,
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
			const asks = yield* inTurn(work, unused, (toolkit) =>
				Effect.gen(function* () {
					const tool = toolkit.tools[WorkPlugin.names.submitPlan]
					if (tool === undefined) return yield* Effect.die("No plan tool")
					return yield* needsApproval(tool, { items: "none" }, "call_1")
				}),
			).pipe(Effect.provide(pluginWith(checks)))
			assert.isFalse(asks)
			assert.isTrue(HashMap.isEmpty(yield* Ref.get(work.checks)))
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
						Toolkit.WithHandler<WorkPlugin.Tools>
					>
				).pipe(
					Effect.flatMap((handled) =>
						handled.handle(
							WorkPlugin.names.remind,
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
