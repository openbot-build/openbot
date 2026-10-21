import {
	Agent,
	Config,
	Item,
	Timeline,
	Session,
	SessionStore,
	Turn,
} from "@openbot-build/core"
import {
	SessionBusy,
	SessionModelInvalid,
	type SessionModels,
	type SelectSessionModelRequest,
	SessionNotFound,
	SessionConflict,
	SessionInvalidRecord,
	SessionStorageUnavailable,
	SessionExecutionUnavailable,
	type Identity,
	type UpdateSessionRequest,
	type ForkSessionRequest,
	type RestoreSessionRequest,
	type SessionActivity,
	type SessionResponse,
	type SessionResponseSseEvent,
	type SessionView,
	type SessionSummary,
	type CreateSessionRequest,
	type StartTurnRequest,
	type MemoryCommand,
	type AgentsApi,
	type SessionKind,
	type SessionParent,
	type SessionMemory,
} from "@openbot-build/platform-api"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { LanguageModel, type Tool, type Toolkit } from "effect/ai"
import { type Memory } from "@openbot-build/plugin-memory"
import type { Tools as AppTools } from "../apps/AppPlugin.ts"
import type * as SessionHost from "./SessionHost.ts"

/** What a new Session needs: the Agent that works in it and where the work came from. */
export interface CreateInput {
	readonly agent: AgentsApi.Agent
	readonly kind: SessionKind
	readonly chain: SessionHost.Chain
	readonly parent?: SessionParent
	readonly review?: string
	readonly title?: string
	readonly settings?: CreateSessionRequest["settings"]
}

export type ServiceError =
	| SessionNotFound
	| SessionBusy
	| SessionConflict
	| SessionInvalidRecord
	| SessionStorageUnavailable
	| SessionModelInvalid

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
	readonly defaults?: Effect.Effect<Partial<Turn.Settings>>
	readonly resolveModel?: (
		selection: Config.Selection | undefined,
	) => Effect.Effect<
		LanguageModel.LanguageModel,
		Config.ModelConfigurationError
	>
	/**
	 * Your own model and policy for learned memory, and the server default for the switches.
	 * A Session can override each switch. Both switches are on when you do not set them.
	 */
	readonly memory?: Memory.Options & {
		readonly defaults?: Partial<Memory.Settings>
	}
	readonly namespace?: string
	readonly runtime?: Agent.Definition<Tools, E, R, BuildE, BuildR>
	readonly layerExecution?: (
		ref: Session.Ref,
		namespace: string,
	) => Layer.Layer<ExecutionServices<Tools, R>, E>
}

export class Sessions extends Context.Service<
	Sessions,
	{
		readonly selectMode: (
			id: Session.Id,
			input: {
				readonly expected: Session.Revision
				readonly mode: Config.Mode
			},
		) => Effect.Effect<SessionView, ServiceError>
		readonly versions: (
			id: Session.Id,
		) => Effect.Effect<ReadonlyArray<Timeline.Version>, ServiceError>
		/** The tool calls of the current Turn that wait for an answer. */
		readonly waits: (
			id: Session.Id,
		) => Effect.Effect<ReadonlyArray<Session.Wait>, ServiceError>
		readonly models: (
			id: Session.Id,
		) => Effect.Effect<SessionModels, ServiceError>
		readonly selectModel: (
			id: Session.Id,
			input: SelectSessionModelRequest,
		) => Effect.Effect<
			SessionView,
			ServiceError | SessionModelInvalid | SessionExecutionUnavailable
		>
		readonly memory: (
			id: Session.Id,
		) => Effect.Effect<SessionMemory, ServiceError>
		readonly updateMemory: (
			id: Session.Id,
			input: {
				readonly expected: Timeline.VersionId
				readonly revision: Session.Revision
				readonly command: MemoryCommand
			},
		) => Effect.Effect<SessionView, ServiceError>
		readonly list: (input?: {
			readonly archived?: boolean
			readonly agent?: string
			readonly kind?: SessionKind
		}) => Effect.Effect<ReadonlyArray<SessionSummary>, ServiceError>
		readonly update: (
			id: Session.Id,
			input: UpdateSessionRequest,
		) => Effect.Effect<SessionView, ServiceError>
		readonly remove: (id: Session.Id) => Effect.Effect<void, ServiceError>
		readonly fork: (
			id: Session.Id,
			input: ForkSessionRequest,
		) => Effect.Effect<SessionView, ServiceError>
		readonly history: (
			id: Session.Id,
			version?: Timeline.VersionId,
		) => Effect.Effect<Timeline.State, ServiceError>
		readonly exportRecord: (
			id: Session.Id,
		) => Effect.Effect<SessionStore.Record, ServiceError>
		readonly restore: (
			id: Session.Id,
			input: RestoreSessionRequest,
		) => Effect.Effect<SessionView, ServiceError>
		readonly wait: (
			id: Session.Id,
			after: Session.Revision,
			timeoutMs?: number,
			afterActivity?: SessionActivity,
		) => Effect.Effect<SessionView, ServiceError>
		readonly interrupt: (
			id: Session.Id,
			turn: Turn.Id,
		) => Effect.Effect<SessionView, ServiceError>
		readonly create: (
			input: CreateInput,
		) => Effect.Effect<SessionView, ServiceError>
		readonly get: (id: Session.Id) => Effect.Effect<SessionView, ServiceError>
		readonly send: (
			id: Session.Id,
			input: StartTurnRequest,
		) => Effect.Effect<
			SessionResponse,
			ServiceError | SessionExecutionUnavailable
		>
		readonly startAction: (
			id: Session.Id,
			input: {
				readonly expected: Session.Revision
				readonly action: Turn.Action
				readonly turn?: Turn.Id
			},
		) => Effect.Effect<Session.ActionReceipt, ServiceError>
		/**
		 * Answers a waiting tool call of the current Turn. It does nothing when the call
		 * does not wait any more, so a second answer is safe.
		 */
		readonly resolveCall: (
			id: Session.Id,
			toolCallId: string,
			outcome: Session.Outcome,
		) => Effect.Effect<void, ServiceError | SessionExecutionUnavailable>
		readonly resume: (
			id: Session.Id,
		) => Effect.Effect<SessionView, ServiceError>
		readonly settings: (
			id: Session.Id,
			input: {
				readonly expected: Session.Revision
				readonly settings: Turn.Settings
			},
		) => Effect.Effect<SessionView, ServiceError | SessionModelInvalid>
		readonly turns: (
			id: Session.Id,
			input: { readonly after?: Turn.Id; readonly limit?: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Turn.Record>
				readonly next: Turn.Id | null
			},
			ServiceError
		>
		readonly turn: (
			id: Session.Id,
			turn: Turn.Id,
		) => Effect.Effect<
			{ readonly turn: Turn.Record; readonly response: SessionResponse },
			ServiceError
		>
		readonly items: (
			id: Session.Id,
			turn: Turn.Id,
			input: { readonly after?: Item.Id; readonly limit?: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<Item.Record>
				readonly next: Item.Id | null
			},
			ServiceError
		>
		readonly steer: (
			id: Session.Id,
			turn: Turn.Id,
			input: StartTurnRequest["input"],
		) => Effect.Effect<Session.Receipt, ServiceError>
		readonly enqueue: (
			id: Session.Id,
			input: {
				readonly input: StartTurnRequest["input"]
				readonly expected?: Session.Revision
			},
		) => Effect.Effect<
			{
				readonly session: Session.Id
				readonly item: Item.Id
				readonly revision: Session.Revision
			},
			ServiceError
		>

		readonly sendStream: (
			id: Session.Id,
			input: StartTurnRequest,
		) => Effect.Effect<
			Stream.Stream<SessionResponseSseEvent>,
			ServiceError | SessionExecutionUnavailable,
			Scope.Scope
		>
	}
>()("@openbot-build/platform/sessions/Sessions") {}

export type Instance<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
> = typeof Sessions.Service & {
	readonly runtime: Session.Runtime<
		SessionHost.Values,
		Tools,
		| E
		| Timeline.VersionError
		| Session.SessionNotFound
		| Session.SessionError
		| SessionStore.SessionStoreError,
		R,
		AppTools
	>
	readonly store: SessionStore.Store<SessionHost.Values>
	readonly consolidate: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<SessionHost.Values>,
		ServiceError,
		LanguageModel.LanguageModel
	>
}
