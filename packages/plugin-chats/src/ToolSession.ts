import type { Paused } from "@openbot-build/server-execution/Admission"
import { type Developers, Execution } from "@openbot-build/domain"
import {
	type Failure,
	TurnContext,
} from "@openbot-build/conversation-contract/chats/TurnContext"
import {
	type Scope,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import { Bot, Chat } from "@openbot-build/core"
import { Prompt, Toolkit, type Tool } from "effect/ai"
import * as Hex from "effect/encoding/Hex"
import { Work } from "@openbot-build/conversation-contract/capabilities/Work"
import * as Db from "@openbot-build/server-database/Database"
import { Calls } from "@openbot-build/server-execution/Calls"
import * as Background from "@openbot-build/server-kernel/Background"
import { type Fence } from "@openbot-build/server-execution/Store"
import { ExecutionFeatures } from "./ExecutionFeatures.ts"
import { HostTools } from "@openbot-build/tools-contract/HostTools"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import * as StoredChats from "@openbot-build/conversation-contract/chats/StoredChats"
import { ToolCommands } from "@openbot-build/conversation-contract/chats/ToolCommands"
import { ToolSteps, beforeSend } from "./ToolSteps.ts"

export interface Service {
	readonly run: (
		fence: Fence,
	) => Effect.Effect<
		Schema.Json,
		| Execution.Conflict
		| Execution.NotFound
		| Execution.OutcomeUnknown
		| Paused
		| Developers.StorageFailure
		| Execution.Failure
		| Failure,
		Scope.Scope
	>
}

export class ToolSession extends Context.Service<ToolSession, Service>()(
	"@openbot-build/plugin-chats/ToolSession",
) {}

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
	const crypto = yield* Digest.Digest
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
				: yield* featureScopes.restore(fence, saved.input.definition)
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
					yield* crypto.digest(Digest.sha256, new TextEncoder().encode(name)),
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
	return ToolSession.of({ run })
})

export const layer = Layer.effect(ToolSession, make)
