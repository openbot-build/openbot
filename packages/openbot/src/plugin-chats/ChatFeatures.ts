import { Bot, Chat, type ChatStore, Operations } from "@openbot-build/core"
import type { Identity, ExecutionIdentity } from "@openbot-build/domain"
import {
	Cause,
	Context,
	Duration,
	Effect,
	Layer,
	Record as Rec,
	type Scope,
} from "effect"
import { Prompt, type LanguageModel, type Tool } from "effect/ai"
import * as Background from "../server-kernel/execution/Background.ts"
import * as Report from "../server-kernel/errors/Report.ts"
import { Files } from "../apps-contract/files/Files.ts"
import { withFiles } from "../apps-contract/files/ModelFiles.ts"
import { AppTools } from "../plugin-apps/AppTools.ts"
import { BotTools } from "../plugin-bots/BotTools.ts"
import { ChannelTools } from "../plugin-channels/ChannelTools.ts"
import { ComputerTools } from "../plugin-computers/ComputerTools.ts"
import { names as executionToolNames } from "./ToolControls.ts"
import { WorkTools } from "../plugin-work/WorkTools.ts"
import { operationsOf } from "../server-kernel/settings/Documents.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as ChatHost from "../conversation-contract/chats/ChatHost.ts"
import type {
	InputCommands,
	Input,
} from "../conversation-contract/chats/InputCommands.ts"
import { Work } from "../conversation-contract/capabilities/Work.ts"
import * as Registration from "../tools-contract/plugins/Registration.ts"
import { TurnContext } from "../conversation-contract/chats/TurnContext.ts"

export type Tools = Record<string, Tool.Any>

/** The stored Chat and commands that a Turn gives to its tools. */
export interface TurnInput {
	readonly owner: typeof Identity.Service
	readonly namespace: string
	readonly store: ChatStore.Store<ChatHost.Values>
	/** The control tools of this Turn's execution. */
	readonly controls: Effect.Effect<
		Bot.ToolRegistration,
		Chat.ChatNotFound | ChatStore.ChatStoreError,
		Bot.Context
	>
	/** Gives input to a Chat of the same member. */
	readonly deliver: (
		input: Input,
		key: string,
	) => Effect.Effect<
		unknown,
		Effect.Error<ReturnType<typeof InputCommands.Service.submit>>
	>
}

/**
 * What each execution gets from OpenBot: the tools of
 * its Turn, the decisions on tool calls that ask for approval, the files in
 * model calls, and the limits of background tool calls. The server gives all
 * of them with `layer`. A test of the Chats alone gives `none`.
 */
export class ChatFeatures extends Context.Service<
	ChatFeatures,
	{
		/** Tools that do not wrap the model loop. */
		readonly register: (
			input: TurnInput,
			host: Bot.ToolRegistration,
			identity: ExecutionIdentity,
		) => Effect.Effect<Bot.ToolRegistration, never, Bot.Context | Scope.Scope>
		/** Decides the tool calls that ask for approval. */
		readonly approvals: typeof Chat.Approvals.Service
		/** Gives a model the content of the files that a prompt names. */
		readonly withFiles: (
			model: LanguageModel.LanguageModel,
		) => LanguageModel.LanguageModel
		/** The limits of the background tool calls of an organization. */
		readonly operationSettings: (
			organizationId: string,
		) => Effect.Effect<Operations.Settings>
	}
>()("@openbot-build/openbot/plugin-chats/ChatFeatures") {}

/**
 * No feature tools and no files. Each Turn has only the tools of the host, and a
 * tool call that asks for approval waits.
 */
export const none = Layer.succeed(
	ChatFeatures,
	ChatFeatures.of({
		register: (_, host) => Effect.succeed(host),
		approvals: Chat.Approvals.of({
			decide: () =>
				Effect.succeed(Chat.Decision.Pending({ result: Chat.pendingResult })),
		}),
		withFiles: (model) => model,
		operationSettings: () => Effect.succeed(Operations.defaultSettings),
	}),
)

/**
 * Every feature of a server: Apps, Bots, work, Channels and Computers, the
 * capability gate for tool calls that ask for approval, and files.
 */
export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const apps = yield* AppTools
	const bots = yield* BotTools
	const work = yield* WorkTools
	const channels = yield* ChannelTools
	const computers = yield* ComputerTools
	const files = yield* Files
	const settings = yield* Settings
	const report = yield* Report.make
	const approvals = yield* Chat.Approvals
	const turns = yield* TurnContext
	return ChatFeatures.of({
		approvals,
		register: (input, host, identity) =>
			Effect.gen(function* () {
				const context = yield* Bot.Context
				const at = yield* context.at
				const turn = yield* context.turn
				const view = yield* input.store.read(at.chat)
				if (view.chat.turn?.id !== turn)
					return yield* Chat.ChatError.make({
						reason: "state-conflict",
						message: "The Turn is not current.",
					})
				const current = yield* turns.prepare({
					identity,
					namespace: input.namespace,
					chat: view.chat.id,
					host: ChatHost.hostState(view.chat),
					turn,
				})
				const state = ChatHost.hostState(view.chat)
				const read = (chat: Chat.Id) => input.store.read(chat)
				const registration = yield* Effect.gen(function* () {
					const botTools = yield* bots.register({
						owner: input.owner,
						namespace: input.namespace,
						read,
						items: (chat, query) => input.store.items(chat, query),
					})
					const controls = yield* input.controls
					const workTools = yield* work.register({ read, store: input.store })
					const common = Registration.merge([
						host,
						botTools,
						controls,
						workTools,
					])
					if (state.kind === "review") return common
					const channelTools = yield* channels.register({ read })
					const computerTools = yield* computers.register({
						notify: (chat, notice) =>
							input
								.deliver(
									{
										chat,
										content: Prompt.make(notice.text),
										identity,
										queue: true,
										notice: { kind: "computer_session", ref: notice.ref },
									},
									`computer:${notice.ref}`,
								)
								.pipe(
									background.logFailure(
										"The end of a command session could not reach its Chat",
									),
								),
					})
					const fixed = Registration.merge([
						common,
						channelTools,
						computerTools,
					])
					const occupied: Readonly<Record<string, Tool.Any>> = fixed.tools
					const appTools = yield* apps.register(input.owner, [
						...Rec.keys(occupied),
						...Rec.values(executionToolNames),
					])
					return Registration.merge([
						host,
						appTools,
						botTools,
						controls,
						workTools,
						channelTools,
						computerTools,
					])
				}).pipe(Effect.provideService(Work, current))
				return Registration.select(
					{
						...registration,
						handlers: Context.add(registration.handlers, Work, current),
					},
					{
						review: state.kind === "review",
						plan:
							(view.chat.turn?.id === turn
								? view.chat.turn.settings
								: view.chat.settings
							).mode === "plan",
					},
				)
			}).pipe(Effect.orDie),
		withFiles: (model) => withFiles(model, files.load),
		operationSettings: (organizationId) =>
			settings.organization(organizationId).pipe(
				Effect.map((snapshot) => {
					const limits = operationsOf(snapshot.document)
					return {
						budget: Duration.millis(limits.toolForegroundBudgetMs),
						maxDuration: Duration.millis(limits.toolMaxDurationMs),
						limit: limits.maxBackgroundOperations,
					}
				}),
				Effect.tapCauseIf(Cause.hasFails, (cause) =>
					report(
						"OpenBot could not read the limits of background tool calls. It uses the default limits.",
						cause,
					),
				),
				Effect.orElseSucceed(() => Operations.defaultSettings),
			),
	})
})

export const layer = Layer.effect(ChatFeatures, make)
