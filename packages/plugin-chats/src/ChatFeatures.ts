import { Bot, Chat, type ChatStore, Operations } from "@openbot-build/core"
import type { Identity, ExecutionIdentity } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Record as Rec,
	type Scope,
} from "effect"
import { Prompt, type LanguageModel, type Tool } from "effect/ai"
import * as Background from "@openbot-build/server-kernel/execution/Background"
import * as Report from "@openbot-build/server-kernel/errors/Report"
import { Files } from "@openbot-build/apps-contract/files/Files"
import { withFiles } from "@openbot-build/apps-contract/files/ModelFiles"
import type { Entry } from "@openbot-build/apps-contract/apps/WorkflowTools"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import type { Fence } from "@openbot-build/server-execution/execution/Store"
import type { Definition } from "@openbot-build/tools-contract/chats/ToolDefinitions"
import * as Assembly from "./Assembly.ts"
import { names as executionToolNames } from "./ToolControls.ts"
import { operationsOf } from "@openbot-build/server-kernel/settings/Documents"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import type {
	InputCommands,
	Input,
} from "@openbot-build/conversation-contract/chats/InputCommands"
import { Work } from "@openbot-build/conversation-contract/capabilities/Work"
import * as Registration from "@openbot-build/tools-contract/plugins/Registration"
import { TurnContext } from "@openbot-build/conversation-contract/chats/TurnContext"

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
 * model calls, and the limits of background tool calls. `ExecutionFeatures`
 * makes them for each Turn phase from the features that the Turn holds. A
 * test of the Chats alone gives `none`.
 */
export class ChatFeatures extends Context.Service<
	ChatFeatures,
	{
		/** Tools that do not wrap the model loop. */
		readonly register: (
			input: TurnInput,
			host: Bot.ToolRegistration,
			identity: ExecutionIdentity,
		) => Effect.Effect<
			Bot.ToolRegistration<{}, BotFeatures.FeatureStopped>,
			never,
			Bot.Context | Scope.Scope
		>
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
		/** Gives back a saved tool from its definition, through the features of this Turn. */
		readonly restore: (definition: Definition) => Option.Option<Entry>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
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
		restore: () => Option.none(),
	}),
)

/** A feature that a Turn holds, with its tools for the fence of this phase. */
export interface Prepared {
	readonly contribution: BotFeatures.Contribution
	readonly feature: BotFeatures.Feature
}

/**
 * The features of one Turn phase, in merge order, the capability gate for
 * tool calls that ask for approval, and files.
 */
export const make = (fence: Fence, prepared: ReadonlyArray<Prepared>) =>
	Effect.gen(function* () {
		const background = yield* Background.make
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
					const review = state.kind === "review"
					const notify: BotFeatures.Notify = (chat, notice) =>
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
							)
					const base = {
						owner: input.owner,
						namespace: input.namespace,
						read,
						items: (chat: Chat.Id, query: ChatStore.ItemQuery) =>
							input.store.items(chat, query),
						store: input.store,
						notify,
					}
					const controls: Assembly.Part<Bot.Context | Work | Scope.Scope> = {
						order: 30,
						builtIn: true,
						id: "controls",
						build: "normal",
						register: () => input.controls,
					}
					const features = Arr.map(
						Arr.filter(
							prepared,
							({ contribution }) => !review || contribution.review,
						),
						({
							contribution,
							feature,
						}): Assembly.Part<Bot.Context | Work | Scope.Scope> => ({
							order: contribution.order,
							builtIn: false,
							id: contribution.id,
							build: contribution.build,
							register: (occupied) => feature.register({ ...base, occupied }),
						}),
					)
					const registration = yield* Assembly.assemble(
						host,
						[controls, ...features],
						Rec.values(executionToolNames),
					).pipe(Effect.provideService(Work, current))
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
			// The first feature in merge order with an entry wins: Apps, then Bots.
			restore: (definition) =>
				Arr.findFirst(prepared, ({ contribution }) =>
					contribution.restore === undefined
						? Option.none()
						: contribution.restore(fence, definition),
				),
		})
	})
