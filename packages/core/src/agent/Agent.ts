import {
	Channel,
	Context as EffectContext,
	Data,
	Effect,
	Scope,
	Stream,
} from "effect"
import {
	LanguageModel,
	type Prompt,
	type Response,
	type Toolkit,
	type Tool,
} from "effect/ai"
import type * as Session from "../session/Session.ts"
import type * as Turn from "../session/Turn.ts"
import type * as Item from "../memory/Item.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import type * as Config from "../models/Config.ts"
import type * as Provider from "../models/Provider.ts"
import type * as ContextCompaction from "../context/ContextCompaction.ts"

/** Reusable capabilities. Conversation identity and resources belong to Sessions. */
export interface Definition<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
> {
	readonly plugin?: Plugin.Plugin<Tools, E, R, BuildE, BuildR>
	/** A host plugin owns its extra handlers and codecs inside the execution Scope. */
	readonly hostPlugin?: Plugin.Plugin<HostTools, E, R, BuildE, BuildR>
	readonly toolkit?:
		Toolkit.Toolkit<Tools> | Effect.Effect<Toolkit.Toolkit<Tools>, E, R>
	readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"]
	readonly concurrency?: LanguageModel.GenerateTextOptions<Tools>["concurrency"]
	readonly modelCatalog?: Effect.Effect<ReadonlyArray<Config.Model>>
	readonly providers?: ReadonlyArray<Provider.Provider<E, R, R>>
	readonly compaction?: typeof ContextCompaction.ContextCompaction.Service
}
export interface Options<
	Tools extends Record<string, Tool.Any>,
	E = never,
	R = never,
> {
	readonly prompt: Prompt.RawInput
	readonly action?: Turn.Action
	readonly toolkit:
		Toolkit.WithHandler<Tools> | Effect.Effect<Toolkit.WithHandler<Tools>, E, R>
	readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"]
	readonly concurrency?: LanguageModel.GenerateTextOptions<Tools>["concurrency"]
}
export class Context extends EffectContext.Service<
	Context,
	{
		readonly options: Omit<Options<Record<string, Tool.Any>>, "toolkit">
		readonly at: Effect.Effect<Session.Position>
		readonly turn: Effect.Effect<Turn.Id>
		readonly step: Effect.Effect<number>
		readonly history: Effect.Effect<Prompt.Prompt>
	}
>()("@openbot-build/core/agent/Agent/Context") {
	static provide<A, E, R>(
		stream: Stream.Stream<A, E, R>,
		context: typeof Context.Service,
	): Stream.Stream<A, E, Exclude<R, Context>> {
		return Stream.fromChannel(
			Channel.fromTransform((upstream, parentScope) =>
				Effect.acquireRelease(Scope.make(), (scope, exit) =>
					Scope.close(scope, exit).pipe(
						Effect.provideService(Context, context),
					),
				).pipe(
					Scope.provide(parentScope),
					Effect.flatMap((scope) =>
						Channel.toTransform(Stream.toChannel(stream))(upstream, scope).pipe(
							Effect.provideService(Context, context),
							Effect.map(Effect.provideService(Context, context)),
						),
					),
				),
			),
		)
	}
}
export type Event<
	Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>,
	P = {},
> = Data.TaggedEnum<{
	TurnStarted: { readonly at: Session.Position; readonly turn: Turn.Id }
	ModelStepStarted: {
		readonly at: Session.Position
		readonly turn: Turn.Id
		readonly step: number
	}
	ResponsePart: {
		readonly at: Session.Position
		readonly turn: Turn.Id
		readonly step: number
		readonly item: Item.Id
		readonly part: Response.StreamPart<Tools, "opaque">
	}
	VersionCreated: { readonly view: Session.View<P> }
	TurnWaitingApproval: {
		readonly view: Session.View<P>
		readonly turn: Turn.Record
	}
	TurnCompleted: { readonly view: Session.View<P>; readonly turn: Turn.Record }
}>
interface EventDefinition extends Data.TaggedEnum.WithGenerics<1> {
	readonly taggedEnum: Event<
		this["A"] extends Record<string, Tool.Any> ? this["A"] : never
	>
}
export const Event = Data.taggedEnum<EventDefinition>()
// The inferred type is named ToolConfig, not Config. With the name Config,
// the declaration bundler (rolldown-plugin-dts 0.28.8) points it at the imported Config namespace.
type ExecutionToolError<T> =
	T extends Tool.Tool<infer _Name, infer ToolConfig, infer _Requirements>
		? "error" extends ToolConfig["failureMode"]
			? ToolConfig["failure"]["Type"]
			: never
		: never
export type ExecutionError<Tools extends Record<string, Tool.Any>, E = never> =
	| E
	| LanguageModel.ExtractError<{ readonly toolkit: Toolkit.WithHandler<Tools> }>
	| ExecutionToolError<Tools[keyof Tools]>
export type Requirements<Tools extends Record<string, Tool.Any>, R = never> =
	| R
	| LanguageModel.LanguageModel
	| LanguageModel.ExtractServices<{
			readonly toolkit: Toolkit.WithHandler<Tools>
	  }>
export type RuntimeServices<
	Tools extends Record<string, Tool.Any>,
	R = never,
> = Exclude<Requirements<Tools, R | Tool.HandlersFor<Tools>>, Context>
export type ActionServices<Tools extends Record<string, Tool.Any>, R = never> =
	R | Exclude<RuntimeServices<Tools>, LanguageModel.LanguageModel>
