import {
	Chat,
	ChatRuntime,
	type ChatStore,
	Operations,
	Plugin,
	PluginComposition,
} from "@openbot-build/core"
import type {
	ChatExecutionUnavailable,
	Identity,
	MessageReceipt,
} from "@openbot-build/api"
import { Context, Duration, Effect, Layer, pipe } from "effect"
import type { LanguageModel, Tool, Toolkit } from "effect/ai"
import * as Background from "../app/Background.ts"
import { Files } from "../files/Files.ts"
import { withFiles } from "../files/ModelFiles.ts"
import { AppPlugin, type Tools as AppTools } from "../plugins/apps/AppPlugin.ts"
import { BotPlugin, type Tools as BotTools } from "../plugins/bots/BotPlugin.ts"
import {
	ChannelPlugin,
	type Tools as ChannelTools,
} from "../plugins/channels/ChannelPlugin.ts"
import {
	ComputerPlugin,
	type Tools as ComputerTools,
} from "../plugins/computers/ComputerPlugin.ts"
import * as OperationsPlugin from "../plugins/operations/OperationsPlugin.ts"
import {
	WorkPlugin,
	type Tools as WorkTools,
} from "../plugins/work/WorkPlugin.ts"
import { operationsOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import type * as ChatHost from "./ChatHost.ts"
import type * as Chats from "./Chats.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/chat-features")

/** The tools of two plugins, when the first runs outside the second. */
type Merged<
	Outer extends Record<string, Tool.Any>,
	Inner extends Record<string, Tool.Any>,
> = Toolkit.MergedTools<[Toolkit.Toolkit<Outer>, Toolkit.Toolkit<Inner>]>

/**
 * The tools that the plugins give to a Turn. Each plugin adds tools with
 * JSON Schema parameters, so their names are known only at run time.
 */
export type Tools = Merged<
	AppTools,
	Merged<
		Merged<
			Merged<Merged<BotTools, OperationsPlugin.Tools>, WorkTools>,
			ChannelTools
		>,
		ComputerTools
	>
>

/** What the Chats of one member give to the plugins of their Turns. */
export interface PluginInput {
	readonly owner: typeof Identity.Service
	readonly namespace: string
	readonly store: ChatStore.Store<ChatHost.Values>
	/** The background tool calls of the Chats. */
	readonly operations: typeof Operations.Operations.Service
	/** Gives input to a Chat of the same member. */
	readonly deliver: (
		chat: Chat.Id,
		input: Chats.DeliverInput,
	) => Effect.Effect<
		MessageReceipt,
		Chats.ServiceError | ChatExecutionUnavailable
	>
}

/**
 * What the Chats of each member get from the rest of OpenBot: the plugins of
 * each Turn, the decisions on tool calls that ask for approval, the files in
 * model calls, and the limits of background tool calls. The server gives all
 * of them with `layer`. A test of the Chats alone gives `none`.
 */
export class ChatFeatures extends Context.Service<
	ChatFeatures,
	{
		/** The plugins of the Turns of one member. */
		readonly plugins: (input: PluginInput) => Plugin.Plugin<Tools>
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
>()("@openbot-build/openbot/chats/ChatFeatures") {}

/**
 * No plugins and no files. Each Turn has only the tools of the host, and a
 * tool call that asks for approval waits.
 */
export const none = Layer.succeed(
	ChatFeatures,
	ChatFeatures.of({
		plugins: () =>
			Plugin.make({ id: pluginId })<Tools>(() =>
				Effect.succeed((next, options) => next(options)),
			),
		approvals: Chat.Approvals.of({
			decide: () =>
				Effect.succeed(
					Chat.Decision.Pending({ result: ChatRuntime.pendingResult }),
				),
		}),
		withFiles: (model) => model,
		operationSettings: () => Effect.succeed(Operations.defaultSettings),
	}),
)

/**
 * Every feature of a server: Apps, Bots, work, Channels and Computers, the
 * capability gate for tool calls that ask for approval, and files.
 */
export const layer = Layer.effect(
	ChatFeatures,
	Effect.gen(function* () {
		const apps = yield* AppPlugin
		const bots = yield* BotPlugin
		const work = yield* WorkPlugin
		const channels = yield* ChannelPlugin
		const computers = yield* ComputerPlugin
		const files = yield* Files
		const settings = yield* Settings
		const approvals = yield* Chat.Approvals
		return ChatFeatures.of({
			approvals,
			// The Bot plugin runs inside the App plugin, so it sees every tool of the Turn.
			// The Operation, work, Channel and Computer plugins run inside the Bot plugin,
			// so they see the current Bot.
			plugins: (input) => {
				const read = (chat: Chat.Id) => input.store.read(chat)
				return PluginComposition.merge(
					apps.forOwner(input.owner),
					pipe(
						bots.forOwner({
							owner: input.owner,
							namespace: input.namespace,
							read,
							items: (chat, query) => input.store.items(chat, query),
							deliver: input.deliver,
						}),
						PluginComposition.merge(OperationsPlugin.make(input.operations)),
						PluginComposition.merge(
							work.forOwner({ read, store: input.store }),
						),
						PluginComposition.merge(channels.forOwner({ read })),
						PluginComposition.merge(
							computers.forOwner({
								notify: (chat, notice) =>
									input
										.deliver(chat, {
											input: notice.text,
											author: notice.author,
											notice: { kind: "computer_session", ref: notice.ref },
										})
										.pipe(
											Background.logFailure(
												"The end of a command session could not reach its Chat",
											),
										),
							}),
						),
					),
				)
			},
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
					Effect.catch((error) =>
						Effect.logWarning(
							"OpenBot could not read the limits of background tool calls. It uses the default limits.",
							error,
						).pipe(Effect.as(Operations.defaultSettings)),
					),
				),
		})
	}),
)
