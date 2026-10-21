import {
	Agent,
	Config,
	Item,
	Memory as CoreMemory,
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
	type SessionResponse,
	type SessionResponseSseEvent,
	type SessionView,
	type SessionSummary,
	type CreateSessionRequest,
	type StartTurnRequest,
	type ToolApproval,
} from "@openbot-build/platform-api"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { LanguageModel, type Tool, type Toolkit } from "effect/ai"
import { type Memory } from "@openbot-build/plugin-memory"
import type { Tools as AppTools } from "../apps/AppPlugin.ts"

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
	readonly memory?: Memory.Options
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
		) => Effect.Effect<ReadonlyArray<CoreMemory.Version>, ServiceError>
		readonly pendingApprovals: (
			id: Session.Id,
		) => Effect.Effect<ReadonlyArray<ToolApproval>, ServiceError>
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
		) => Effect.Effect<Memory.State, ServiceError>
		readonly updateMemory: (
			id: Session.Id,
			input: {
				readonly expected: CoreMemory.VersionId
				readonly revision: Session.Revision
				readonly command: Memory.Command
			},
		) => Effect.Effect<SessionView, ServiceError>
		readonly list: (input?: {
			readonly archived?: boolean
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
			version?: CoreMemory.VersionId,
		) => Effect.Effect<CoreMemory.State, ServiceError>
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
			afterActivity?: "active" | "inactive" | "historical",
		) => Effect.Effect<SessionView, ServiceError>
		readonly interrupt: (
			id: Session.Id,
			turn: Turn.Id,
		) => Effect.Effect<SessionView, ServiceError>
		readonly create: (
			input: CreateSessionRequest,
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
		readonly approve: (
			id: Session.Id,
			input: {
				readonly approvalId: string
				readonly approved: boolean
				readonly grantReads?: boolean
				readonly reason?: string
				readonly expected: Session.Revision
				readonly turn: Turn.Id
			},
		) => Effect.Effect<
			SessionResponse,
			ServiceError | SessionExecutionUnavailable
		>
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
		Memory.Values,
		Tools,
		| E
		| Session.SessionNotFound
		| Session.SessionError
		| SessionStore.SessionStoreError,
		R,
		AppTools
	>
	readonly store: SessionStore.Store<Memory.Values>
	readonly consolidate: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<Memory.Values>,
		ServiceError,
		LanguageModel.LanguageModel
	>
}
