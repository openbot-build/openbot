import { Bot, Chat, ChatStore, Config, Item, Turn } from "@openbot-build/core"
import {
	ChatModelInvalid,
	ChatNotFound,
	ChatConflict,
	ChatStorageUnavailable,
	ChatExecutionUnavailable,
	type ChatModels,
	type ChatActivity,
	type ChatResponse,
	type ChatResponseSseEvent,
	type ChatView,
	type ChatSummary,
	type ChatKind,
	type ChatParent,
	type ChatTodos,
	type Identity,
	type MessageInput,
	type MessageReceipt,
	type UpdateChatRequest,
	type UpdateTodosRequest,
	type BotsApi,
	type PlanApproval,
} from "@openbot-build/api"
import { Context, Effect, Layer, Scope, Stream, Option } from "effect"
import { LanguageModel, type Prompt, type Tool, type Toolkit } from "effect/ai"
import type { Tools as AppTools } from "../plugins/apps/AppPlugin.ts"
import type * as ChatHost from "./ChatHost.ts"

/** What a new Chat needs: the Bot that works in it and where the work came from. */
export interface CreateInput {
	/** A fixed ID, so a second attempt finds the first Chat. */
	readonly id?: Chat.Id
	readonly bot: BotsApi.Bot
	readonly kind: ChatKind
	readonly chain: ChatHost.Chain
	readonly parent?: ChatParent
	readonly review?: string
	readonly planApproval?: PlanApproval.PlanApproval
	readonly trigger?: string
	readonly channel?: ChatHost.ChatHostState["channel"]
	readonly title?: string
}

/**
 * Input from inside OpenBot or from a client. `author` is the member that the input is
 * for. OpenBot always sets it, so the Turns of one person steer each other.
 * A `notice` marks input from OpenBot, such as the end of a delegation.
 */
export interface DeliverInput {
	readonly input: MessageInput | Prompt.Prompt
	readonly author: Turn.Author
	readonly notice?: Item.Notice
	readonly approved?: Chat.ApprovedCall
	/** Wait for the next Turn, also when a Turn of the same author runs. */
	readonly queue?: boolean
}

export type ServiceError =
	ChatNotFound | ChatConflict | ChatStorageUnavailable | ChatModelInvalid

export type ExecutionServices<Tools extends Record<string, Tool.Any>, R> =
	| R
	| Tool.HandlersFor<Tools>
	| LanguageModel.ExtractServices<{
			readonly toolkit: Toolkit.WithHandler<Tools>
	  }>

export interface Options<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
> {
	readonly owner?: typeof Identity.Service
	readonly modelDefaults?: (
		selection: Config.Selection,
	) => Effect.Effect<Config.Selection>
	readonly modelCatalog?: Effect.Effect<{
		readonly providers: ReadonlyArray<Config.Provider>
		readonly models: ReadonlyArray<Config.Model>
	}>
	/**
	 * Settings that the host gives to each new Chat, such as the simulated
	 * model of a development platform or of a test. They come before the model
	 * of the Bot. A real platform never sets them: each Chat gets its model
	 * from its own settings or from its Bot.
	 */
	readonly defaults?: Effect.Effect<Partial<Turn.Settings>>
	readonly resolveModel?: (
		selection: Config.Selection | undefined,
	) => Effect.Effect<
		LanguageModel.LanguageModel,
		Config.ModelConfigurationError
	>
	/**
	 * The settings of the organization of the owner, read on each use.
	 * They come before the static options above.
	 */
	readonly organization?: (organizationId: string) => OrganizationOptions
	readonly namespace?: string
	readonly runtime?: Bot.Definition<Tools, E, R, BuildE, BuildR>
	readonly layerExecution?: (
		ref: Chat.Ref,
		namespace: string,
	) => Layer.Layer<ExecutionServices<Tools, R>, E>
}

/** The options that come from the settings of an organization. */
export type OrganizationOptions = Required<
	Pick<Options, "modelCatalog" | "resolveModel">
>

export class Chats extends Context.Service<
	Chats,
	{
		readonly create: (
			input: CreateInput,
		) => Effect.Effect<ChatView, ServiceError>
		/**
		 * The direct Chat of a member with a Bot. OpenBot makes it the first time.
		 * Each member has one direct Chat with each Bot.
		 */
		readonly direct: (
			bot: BotsApi.Bot,
			chain: ChatHost.Chain,
		) => Effect.Effect<Chat.Id, ServiceError>
		readonly get: (id: Chat.Id) => Effect.Effect<ChatView, ServiceError>
		/** The record of a Chat, with its OpenBot data. */
		readonly read: (
			id: Chat.Id,
		) => Effect.Effect<Chat.View<ChatHost.Values>, ServiceError>
		readonly list: (input?: {
			readonly bot?: string
			readonly kind?: ChatKind
			readonly kinds?: ReadonlyArray<ChatKind>
		}) => Effect.Effect<ReadonlyArray<ChatSummary>, ServiceError>
		readonly update: (
			id: Chat.Id,
			input: UpdateChatRequest,
		) => Effect.Effect<ChatView, ServiceError | ChatExecutionUnavailable>
		readonly change: (
			id: Chat.Id,
			update: (state: ChatHost.ChatHostState) => ChatHost.ChatHostState,
		) => Effect.Effect<void, ServiceError>
		readonly remove: (id: Chat.Id) => Effect.Effect<void, ServiceError>
		readonly models: (id: Chat.Id) => Effect.Effect<ChatModels, ServiceError>
		readonly todos: (id: Chat.Id) => Effect.Effect<ChatTodos, ServiceError>
		readonly updateTodos: (
			id: Chat.Id,
			input: UpdateTodosRequest,
		) => Effect.Effect<ChatView, ServiceError>
		readonly wait: (
			id: Chat.Id,
			after: Chat.Revision,
			timeoutMs?: number,
			afterActivity?: ChatActivity,
		) => Effect.Effect<ChatView, ServiceError>
		/** Stops the running Turn. It does nothing when no Turn runs. */
		readonly interrupt: (id: Chat.Id) => Effect.Effect<ChatView, ServiceError>
		/**
		 * Gives input to a Chat. It starts a Turn when the Chat is free, steers the
		 * running Turn of the same author, or waits in the inbox.
		 */
		readonly deliver: (
			id: Chat.Id,
			input: DeliverInput,
		) => Effect.Effect<MessageReceipt, ServiceError | ChatExecutionUnavailable>
		/**
		 * Like deliver. When the input starts a Turn, it also gives the live events
		 * of that Turn.
		 */
		readonly deliverStream: (
			id: Chat.Id,
			input: DeliverInput,
		) => Effect.Effect<
			{
				readonly receipt: MessageReceipt
				readonly events: Option.Option<Stream.Stream<ChatResponseSseEvent>>
			},
			ServiceError | ChatExecutionUnavailable,
			Scope.Scope
		>
		/** Starts the next Turn from the inbox, when the Chat is free and input waits. */
		readonly drain: (
			id: Chat.Id,
		) => Effect.Effect<void, ServiceError | ChatExecutionUnavailable>
		/**
		 * Ends a Turn that says it runs while no process runs it, for example after a
		 * crash. Its unread input goes back to the inbox.
		 */
		readonly closeStale: (
			id: Chat.Id,
			turn: Turn.Id,
		) => Effect.Effect<void, ServiceError>
		readonly startAction: (
			id: Chat.Id,
			input: {
				readonly action: Turn.Action
				readonly turn?: Turn.Id
				readonly author?: Turn.Author
			},
		) => Effect.Effect<Chat.ActionReceipt, ServiceError>
		readonly turns: (
			id: Chat.Id,
			input: { readonly after?: Turn.Id; readonly limit?: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Turn.Record>
				readonly next: Turn.Id | null
			},
			ServiceError
		>
		readonly turn: (
			id: Chat.Id,
			turn: Turn.Id,
		) => Effect.Effect<
			{ readonly turn: Turn.Record; readonly response: ChatResponse },
			ServiceError
		>
		readonly turnItems: (
			id: Chat.Id,
			turn: Turn.Id,
			input: { readonly after?: Item.Id; readonly limit?: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Item.Record>
				readonly next: Item.Id | null
			},
			ServiceError
		>
		/** All the Items of one Turn, oldest first. */
		readonly turnLog: (
			id: Chat.Id,
			turn: Turn.Id,
		) => Effect.Effect<ReadonlyArray<Item.Record>, ServiceError>
		/** The Items after a place in the log, oldest first, with the authors of their Turns. */
		readonly itemsAfter: (
			id: Chat.Id,
			after: number,
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Item.Record>
				readonly authors: ReadonlyMap<Turn.Id, Turn.Author>
			},
			ServiceError
		>
		readonly items: (
			id: Chat.Id,
			input: { readonly before?: Item.Seq; readonly limit?: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Item.Record>
				readonly next: Item.Seq | null
			},
			ServiceError
		>
	}
>()("@openbot-build/openbot/chats/Chats") {}

export type Instance<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
> = typeof Chats.Service & {
	readonly runtime: Chat.Runtime<
		ChatHost.Values,
		Tools,
		E | Chat.ChatNotFound | Chat.ChatError | ChatStore.ChatStoreError,
		R,
		AppTools
	>
	readonly store: ChatStore.Store<ChatHost.Values>
}
