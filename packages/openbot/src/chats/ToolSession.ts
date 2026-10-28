import { Bot, Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { Prompt, Toolkit, type Tool } from "effect/ai"
import * as Hex from "effect/encoding/Hex"
import { Work } from "../capabilities/Work.ts"
import * as Db from "../database/Database.ts"
import { Calls } from "../execution/Calls.ts"
import * as Background from "../execution/Background.ts"
import { type Fence } from "../execution/Store.ts"
import { ExecutionFeatures } from "./ExecutionFeatures.ts"
import { HostTools } from "./HostTools.ts"
import { InputCommands } from "./InputCommands.ts"
import * as StoredChats from "./StoredChats.ts"
import { ToolCommands } from "./ToolCommands.ts"
import { ToolSteps, beforeSend } from "./ToolSteps.ts"
import { TurnContext } from "./TurnContext.ts"

const make = Effect.gen(function* () {
	const background = yield* Background.make
	const db = yield* Db.make
	const commands = yield* ToolCommands
	const inputs = yield* InputCommands
	const calls = yield* Calls
	const steps = yield* ToolSteps
	const turns = yield* TurnContext
	const featureScopes = yield* ExecutionFeatures
	const host = yield* HostTools
	const crypto = yield* Crypto.Crypto
	/** Only a workflow phase owns this scope. No member runtime or parent fiber is held. */
	const run = Effect.fn("ToolSession.run")(function* (fence: Fence) {
		yield* calls.authorize(fence, "replay")
		const saved = yield* commands.load(fence)
		const { position, context: frame, call } = saved.input
		const result = yield* steps.saved(fence, position, call)
		if (Option.isSome(result)) return result.value
		yield* calls.ready(fence)
		const restored =
			saved.input.definition === undefined
				? Option.none()
				: featureScopes.restore(fence, saved.input.definition)
		if (Option.isSome(restored)) {
			const entry = restored.value
			const toolkit = Toolkit.make(entry.tool)
			const handlers = yield* toolkit.toHandlers({
				[entry.tool.name]: entry.handle,
			})
			return yield* Effect.gen(function* () {
				return yield* steps.run(
					fence,
					position,
					{ call, toolkit: yield* toolkit },
					() => Effect.void,
					beforeSend(entry.tool, call, frame.prompt),
					saved.input.definition,
				)
			}).pipe(Effect.provideContext(handlers))
		}
		const current = yield* turns.prepare({
			identity: saved.identity,
			namespace: fence.namespace,
			chat: position.chat,
			host: frame.host,
			turn: position.turn,
		})
		const context = Bot.Context.of({
			options: {
				prompt: frame.prompt,
				...(frame.action === undefined ? {} : { action: frame.action }),
			},
			at: StoredChats.ref(db, fence.namespace, position.chat).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(Chat.ChatNotFound.make({ chat: position.chat })),
						onSome: (chat) => Effect.succeed(Chat.position(chat)),
					}),
				),
			),
			turn: Effect.succeed(position.turn),
			step: Effect.succeed(position.step),
			history: Effect.succeed(frame.prompt),
		})
		// A session callback keeps application services and identity data, not a Turn scope.
		const notify: Parameters<typeof featureScopes.restoreTool>[2]["notify"] = (
			chat,
			notice,
		) =>
			Effect.gen(function* () {
				const name = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Array(Schema.String)),
				)([fence.id, chat, notice.ref])
				const key = Hex.encode(
					yield* crypto.digest("SHA-256", new TextEncoder().encode(name)),
				)
				yield* inputs.submit(
					fence.namespace,
					Execution.CommandKey.make(`computer:${key}`),
					{
						chat,
						identity: saved.identity,
						content: Prompt.make(notice.text),
						queue: true,
						notice: { kind: "computer_session", ref: notice.ref },
					},
				)
			}).pipe(
				background.logFailure(
					"The end of a command session could not reach its Chat",
				),
			)
		return yield* Effect.gen(function* () {
			const registration = yield* featureScopes.restoreTool(fence, current, {
				name: call.name,
				notify,
				host: host.register,
				policy: {
					review: frame.host.kind === "review",
					plan: frame.settings.mode === "plan",
				},
			})
			const tools: Readonly<Record<string, Tool.Any>> = registration.tools
			const tool = tools[call.name]
			if (tool === undefined)
				return yield* Execution.Conflict.make({ id: fence.id })
			const toolkit = yield* Toolkit.make(
				...Rec.values(registration.tools),
			).pipe(Effect.provideContext(registration.handlers))
			return yield* steps
				.run(
					fence,
					position,
					{ call, toolkit },
					() => Effect.void,
					beforeSend(tool, call, frame.prompt),
					saved.input.definition,
				)
				.pipe(Effect.provideContext(registration.handlers))
		}).pipe(
			Effect.provideService(Work, current),
			Effect.provideService(Bot.Context, context),
		)
	})
	return { run }
})

export class ToolSession extends Context.Service<
	ToolSession,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/chats/ToolSession") {}
export const layer = Layer.effect(ToolSession, make)
