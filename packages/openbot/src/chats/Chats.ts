import type { Duration } from "effect"
import {
	Chat,
	ChatStore,
	type Config,
	Item,
	type Operations,
	Turn,
} from "@openbot-build/core"
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
	type SwitchChatExecutionRequest,
	type ChatExecutionMode,
	type ChatExecutionBlocked,
	type UpdateTodosRequest,
	type BotsApi,
	type PlanApproval,
} from "@openbot-build/api"
import {
	Context,
	type Effect,
	type Scope,
	type Stream,
	type Option,
} from "effect"
import type { LanguageModel, Prompt } from "effect/ai"
import type { Tools as PluginTools } from "./ChatFeatures.ts"
import type * as ChatHost from "./ChatHost.ts"

/** What a new Chat needs: the Bot that works in it and where the work came from. */
export interface CreateInput {
	/** A fixed ID, so a second attempt finds the first Chat. */
	readonly id?: Chat.Id
	readonly bot: BotsApi.Bot
	readonly kind: ChatKind
	readonly chain: ChatHost.Chain
	/** The model of a live Chat. Without it, the Chat gets the first Live model. */
	readonly model?: Config.Selection
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
	/** Adds context, such as an image, without starting an answer. Only the host sets this. */
	readonly passive?: true
	/** A Live input belongs to this saved connection. Only the host sets this. */
	readonly expectedExecution?: {
		readonly generation: number
		readonly sessionId: string
	}
}

export type ServiceError =
	ChatNotFound | ChatConflict | ChatStorageUnavailable | ChatModelInvalid

/** The models that the Chats of one runtime can use. */
export interface Catalog {
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
}

/**
 * What one Chat runtime is made from. `Backend` makes a runtime for each
 * member, with the models of the organization of the member.
 */
export interface Options {
	readonly owner?: typeof Identity.Service
	readonly namespace?: string
	/** The language models that a Chat can use. */
	readonly modelCatalog: Effect.Effect<Catalog>
	/** The Live models that a live Chat can use. Without them, OpenBot makes no live Chats. */
	readonly liveCatalog?: Effect.Effect<Catalog>
	/** The model that a selection names. */
	readonly resolveModel: (
		selection: Config.Selection,
	) => Effect.Effect<
		LanguageModel.LanguageModel,
		Config.ModelConfigurationError
	>
	/**
	 * The model of a new Chat when its Bot names none. Only a simulated
	 * platform has one, such as development or a test. On a real platform,
	 * each Bot names its model.
	 */
	readonly defaultModel?: Config.Selection
	/** The Bot model to use when an old Live Chat first selects Chat execution. */
	readonly chatModel?: (
		bot: BotsApi.BotId,
	) => Effect.Effect<Config.Selection | undefined, ChatModelInvalid>
	/** Checks the full saved context without running a model or any tool. */
	readonly validateExecution?: (input: {
		readonly context: Prompt.Prompt
		readonly selection: Config.Selection
		readonly mode: ChatExecutionMode
	}) => Effect.Effect<void, ChatExecutionBlocked>
}

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
		readonly switchExecution: (
			id: Chat.Id,
			input: SwitchChatExecutionRequest,
		) => Effect.Effect<
			ChatView,
			ServiceError | ChatExecutionUnavailable | ChatExecutionBlocked
		>
		/** Changes only execution state under the Chat revision lock. */
		readonly changeExecution: (
			id: Chat.Id,
			update: (
				chat: Chat.Ref,
			) => Effect.Effect<ChatHost.ExecutionState, ChatExecutionBlocked>,
		) => Effect.Effect<void, ServiceError | ChatExecutionBlocked>
		/** Reads a stable saved context. Reading never starts a Turn. */
		readonly executionContext: (
			id: Chat.Id,
			expected?: Chat.Revision,
		) => Effect.Effect<
			{
				readonly chat: Chat.Id
				readonly revision: Chat.Revision
				readonly seq: Item.Seq
				readonly prompt: Prompt.Prompt
			},
			ServiceError
		>
		/** Old connections may not send input after a change of execution. */
		readonly checkExecution: (
			id: Chat.Id,
			generation: number,
			mode: ChatExecutionMode,
		) => Effect.Effect<boolean, ServiceError>
		/** A closing connection can stop only the Turn that it owned. */
		readonly interruptExecution: (
			id: Chat.Id,
			generation: number,
			turn: Turn.Id,
		) => Effect.Effect<void, ServiceError>
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
			timeout?: Duration.Input,
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
		/** The tool calls of the Chats that went on in the background. */
		readonly operations: typeof Operations.Operations.Service
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

export type Instance = typeof Chats.Service & {
	readonly runtime: Chat.Runtime<
		ChatHost.Values,
		{},
		Chat.ChatNotFound | Chat.ChatError | ChatStore.ChatStoreError,
		PluginTools
	>
	readonly store: ChatStore.Store<ChatHost.Values>
}
