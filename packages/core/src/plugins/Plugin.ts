import {
	Context as EffectContext,
	Data,
	Schema,
	type Brand,
	Effect,
	type Option,
	type Scope,
} from "effect"
import { type Prompt, type Toolkit, type Tool, type Response } from "effect/ai"
import {
	Context,
	type ToolRegistration,
	type Options as BotOptions,
} from "../bot/Bot.ts"
import type * as Turn from "../chat/Turn.ts"
import type * as Chat from "../chat/Chat.ts"
import type * as ChatStore from "../store/ChatStore.ts"

export const Id = Schema.String.check(
	Schema.makeFilter(
		(id) =>
			(id !== "chat" && id !== "conversation") ||
			"Core namespaces are reserved",
	),
).pipe(Schema.brand("@openbot-build/core/PluginId"))
export type Id<Key extends string = string> = Key & typeof Id.Type

/** Identity data for a plugin. Tools are built in the Turn scope. */
export interface Definition<I extends Id = Id> {
	readonly id: I
}

/**
 * Persistent plugin data with an explicit owner and its current Codec.
 * `record` data is kept on the small record of the Chat, which every read loads.
 * `state` data is kept with the conversation.
 */
export interface StateDeclaration {
	readonly scope: "record" | "state"
	readonly schema: Schema.ConstraintCodec<
		unknown,
		Schema.Json,
		unknown,
		unknown
	>
}
export type Stores = Readonly<Record<string, StateDeclaration>>
export interface StoreDefinition<
	S extends Schema.ConstraintCodec<unknown, Schema.Json, unknown, unknown>,
> extends StateDeclaration {
	readonly schema: S
}

/** Typed view of the current Chat. Missing plugin data is explicit. */
export interface StoreState<A> {
	readonly at: Chat.Position
	readonly value: Option.Option<A>
}

/** The host binds these operations to one Plugin.Id and the current Chat. */
/** Store operations keep host failures and dependencies, as well as commit failures. */
export type StoreEffect<A, E, R> = Effect.Effect<
	A,
	Chat.ChatNotFound | Chat.ChatError | ChatStore.ChatStoreError | E,
	R
>

/** Operations on this plugin's optional value. An update may run again after a write conflict, so it must have no outside effects. */
export interface StoreOperations<A, E = never, R = never> {
	readonly get: StoreEffect<Option.Option<A>, E, R>
	readonly snapshot: StoreEffect<StoreState<A>, E, R>
	/** Replaces the value only if the revision that snapshot returned still matches. */
	readonly setAt: (input: {
		readonly base: Chat.Position
		readonly value: Option.Option<A>
	}) => StoreEffect<Chat.Ref, E, R>
	readonly set: (value: Option.Option<A>) => StoreEffect<void, E, R>
	readonly getAndSet: (
		value: Option.Option<A>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly setAndGet: (
		value: Option.Option<A>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly modify: <B>(
		f: (value: Option.Option<A>) => readonly [B, Option.Option<A>],
	) => StoreEffect<B, E, R>
	readonly modifyEffect: <B, E2, R2>(
		f: (
			value: Option.Option<A>,
		) => Effect.Effect<readonly [B, Option.Option<A>], E2, R2>,
	) => StoreEffect<B, E | E2, R | R2>
	readonly modifySome: <B>(
		f: (
			value: Option.Option<A>,
		) => readonly [B, Option.Option<Option.Option<A>>],
	) => StoreEffect<B, E, R>
	readonly modifySomeEffect: <B, E2, R2>(
		f: (
			value: Option.Option<A>,
		) => Effect.Effect<readonly [B, Option.Option<Option.Option<A>>], E2, R2>,
	) => StoreEffect<B, E | E2, R | R2>
	readonly update: (
		f: (value: Option.Option<A>) => Option.Option<A>,
	) => StoreEffect<void, E, R>
	readonly updateEffect: <E2, R2>(
		f: (value: Option.Option<A>) => Effect.Effect<Option.Option<A>, E2, R2>,
	) => StoreEffect<void, E | E2, R | R2>
	readonly getAndUpdate: (
		f: (value: Option.Option<A>) => Option.Option<A>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly getAndUpdateEffect: <E2, R2>(
		f: (value: Option.Option<A>) => Effect.Effect<Option.Option<A>, E2, R2>,
	) => StoreEffect<Option.Option<A>, E | E2, R | R2>
	readonly updateAndGet: (
		f: (value: Option.Option<A>) => Option.Option<A>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly updateAndGetEffect: <E2, R2>(
		f: (value: Option.Option<A>) => Effect.Effect<Option.Option<A>, E2, R2>,
	) => StoreEffect<Option.Option<A>, E | E2, R | R2>
	readonly updateSome: (
		f: (value: Option.Option<A>) => Option.Option<Option.Option<A>>,
	) => StoreEffect<void, E, R>
	readonly updateSomeEffect: <E2, R2>(
		f: (
			value: Option.Option<A>,
		) => Effect.Effect<Option.Option<Option.Option<A>>, E2, R2>,
	) => StoreEffect<void, E | E2, R | R2>
	readonly getAndUpdateSome: (
		f: (value: Option.Option<A>) => Option.Option<Option.Option<A>>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly getAndUpdateSomeEffect: <E2, R2>(
		f: (
			value: Option.Option<A>,
		) => Effect.Effect<Option.Option<Option.Option<A>>, E2, R2>,
	) => StoreEffect<Option.Option<A>, E | E2, R | R2>
	readonly updateSomeAndGet: (
		f: (value: Option.Option<A>) => Option.Option<Option.Option<A>>,
	) => StoreEffect<Option.Option<A>, E, R>
	readonly updateSomeAndGetEffect: <E2, R2>(
		f: (
			value: Option.Option<A>,
		) => Effect.Effect<Option.Option<Option.Option<A>>, E2, R2>,
	) => StoreEffect<Option.Option<A>, E | E2, R | R2>
}

/** Module schema data and its operations keep separate types. The caller provides the store. */
export interface Store<
	Declaration extends StateDeclaration,
	E = never,
	R = never,
> extends StoreOperations<Declaration["schema"]["Type"], E, R> {
	readonly definition: Declaration
}

export const StoreIdTypeId: unique symbol = Symbol.for(
	"@openbot-build/core/Plugin/StoreId",
)

/** A key to yield for this plugin's Store. The host provides the implementation at run time. */
export interface StoreService<
	Declaration extends StateDeclaration,
	E = never,
	R = never,
	I extends Id = Id,
> extends EffectContext.Service<
	StoreService<Declaration, E, R, I>,
	Store<Declaration, E, R>
> {
	/** A type-only marker. It tells apart services with the same schemas and operations. */
	readonly [StoreIdTypeId]?: I
	readonly definition: Declaration
}

/** Plugins can declare their persistent state beside their tools. */
export interface Stateful<
	Tools extends Record<string, Tool.Any>,
	E,
	R,
	States extends Stores,
	I extends Id = Id,
	BuildE = never,
	BuildR = never,
> extends Plugin<Tools, E, R, BuildE, BuildR> {
	readonly id: I
	readonly stores: States
}

export interface Stored<
	Tools extends Record<string, Tool.Any>,
	E,
	R,
	Declaration extends StateDeclaration,
	StoreE = Chat.ChatError,
	StoreR = Context,
	I extends Id = Id,
	BuildE = never,
	BuildR = never,
> extends Stateful<
	Tools,
	E,
	R,
	Readonly<Record<Brand.Brand.Unbranded<I>, Declaration>>,
	I,
	BuildE,
	BuildR
> {
	readonly store: StoreService<Declaration, StoreE, StoreR, I>
}

export class StoreConflict extends Schema.TaggedError<
	StoreConflict,
	{ readonly brand: unique symbol }
>()("Plugin.StoreConflict", { id: Id }) {}

/** The saved Turn and the next model step. Checks run before model or tool I/O. */
export interface StepInput {
	readonly turn: Turn.Record
	readonly kind: "model" | "action"
	readonly step: number
	readonly history: Prompt.Prompt
}

/** A saved step result. Hooks can run again after a crash, so writes must deduplicate. */
export interface StepResult extends StepInput {
	readonly chat: Chat.Id
	readonly output: Prompt.Prompt
	readonly finishReason: Response.FinishReason
}

/** The step runner resolves these options once in its work scope. */
export interface Options<
	TK extends Toolkit.Any = Toolkit.Any,
	E = never,
	R = never,
> extends Omit<BotOptions<Record<string, Tool.Any>>, "toolkit"> {
	readonly toolkit: Effect.Effect<TK, E, R>
	readonly instructions: Prompt.Prompt
	/** False ends the Turn before the step. A failure keeps its typed cause. */
	readonly beforeStep?: (input: StepInput) => Effect.Effect<boolean, E, R>
	/** Runs after the model and tool results are saved, before the Turn may end. */
	readonly afterStep?: (input: StepResult) => Effect.Effect<void, E, R>
	/**
	 * Changes the conversation that the model sees in each step. The stored history does not change.
	 * It must keep the number of messages. Otherwise the runtime uses the conversation as it is.
	 * The runner applies registered changes in order.
	 */
	readonly transformPrompt?: (
		prompt: Prompt.Prompt,
	) => Effect.Effect<Prompt.Prompt>
}

/** A plugin registers tools, hooks and state. It does not own an execution stream. */
type Body<Tools extends Record<string, Tool.Any>, E, R> = ToolRegistration<
	Tools,
	E,
	R
>

/** The host provides tool handlers and the model separately. */
export const ToolsTypeId: unique symbol = Symbol.for(
	"@openbot-build/core/Plugin/Tools",
)
export class Plugin<
	Tools extends Record<string, Tool.Any>,
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
> extends Data.TaggedClass("Plugin.Plugin")<{
	readonly id: Id
	readonly register: Effect.Effect<
		Body<Tools, E, R>,
		BuildE,
		BuildR | Scope.Scope
	>
}> {
	/** A type-only marker. It keeps concrete tool definitions through generic host factories. */
	declare readonly [ToolsTypeId]?: Tools
}

const makeRegistration = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	id: Id,
	construct: () => Effect.Effect<
		Body<Tools, E, R>,
		BuildE,
		BuildR | Scope.Scope
	>,
): Plugin<Tools, E, R, BuildE, BuildR> =>
	new Plugin({
		id,
		register: Effect.suspend(construct),
	})

export function make<I extends Id>(input: {
	readonly id: I
	readonly store?: undefined
}): <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	construct: () => Effect.Effect<
		Body<Tools, E, R>,
		BuildE,
		BuildR | Scope.Scope
	>,
) => Plugin<Tools, E, R, BuildE, BuildR> & { readonly id: I }
export function make<
	I extends Id,
	D extends StateDeclaration,
	StoreE = Chat.ChatError,
	StoreR = Context,
>(input: {
	readonly id: I
	readonly store: D
}): <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	construct: (ctx: {
		readonly store: StoreService<D, StoreE, StoreR, I>
	}) => Effect.Effect<Body<Tools, E, R>, BuildE, BuildR | Scope.Scope>,
) => Stored<Tools, E, R, D, StoreE, StoreR, I, BuildE, BuildR>
export function make<
	I extends Id,
	D extends StateDeclaration,
	StoreE = Chat.ChatError,
	StoreR = Context,
>(input: { readonly id: I; readonly store?: D | undefined }) {
	return <
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
	>(
		construct: (ctx?: {
			readonly store: StoreService<D, StoreE, StoreR, I>
		}) => Effect.Effect<Body<Tools, E, R>, BuildE, BuildR | Scope.Scope>,
	) => {
		const definition = input.store
		if (definition !== undefined) {
			/** @effect-expect-leaking StoreR */
			const store = Object.assign(
				EffectContext.Service<
					StoreService<D, StoreE, StoreR, I>,
					Store<D, StoreE, StoreR>
				>(`@openbot-build/core/PluginStore/${input.id}`),
				{ definition },
			)
			// A spread would lose the methods of Plugin, such as `pipe`.
			return Object.assign(
				makeRegistration(input.id, () => construct({ store })),
				{ store, stores: { [input.id]: definition } },
			)
		}
		return makeRegistration(input.id, () => construct())
	}
}
