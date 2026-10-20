import {
	Context as EffectContext,
	Data,
	Schema,
	Stream,
	type Brand,
	Effect,
	type Option,
	type Scope,
} from "effect"
import { type Prompt, type Toolkit, type Tool } from "effect/ai"
import {
	Context,
	type Event,
	type Options as AgentOptions,
} from "../agent/Agent.ts"
import type * as Memory from "../memory/Memory.ts"
import type * as Session from "../session/Session.ts"
import type * as SessionStore from "../store/SessionStore.ts"

export const Id = Schema.String.check(
	Schema.makeFilter(
		(id) =>
			(id !== "session" && id !== "memory") || "Core namespaces are reserved",
	),
).pipe(Schema.brand("@openbot-build/core/PluginId"))
export type Id<Key extends string = string> = Key & typeof Id.Type

/** Identity data for the versioned plugin model. Middleware is built separately. */
export interface Definition<I extends Id = Id> {
	readonly id: I
}

/** Persistent plugin data with an explicit owner and its current Codec. */
export interface StateDeclaration {
	readonly scope: "session" | "memory"
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

/** Typed view at the current branch head. Missing plugin data is explicit. */
export interface StoreState<A> {
	readonly at: Session.Position
	readonly value: Option.Option<A>
}

/** The host binds these operations to one Plugin.Id and the current Session branch. */
/** Store operations keep host failures and dependencies, as well as commit failures. */
export type StoreEffect<A, E, R> = Effect.Effect<
	A,
	| Session.SessionNotFound
	| Memory.VersionError
	| Session.SessionError
	| SessionStore.SessionStoreError
	| E,
	R
>

/** Safe operations, like those of SynchronizedRef, on this plugin's optional value. */
export interface StoreOperations<A, E = never, R = never> {
	readonly get: StoreEffect<Option.Option<A>, E, R>
	readonly snapshot: StoreEffect<StoreState<A>, E, R>
	/** Replaces the value only if the version that snapshot returned still matches. */
	readonly setAt: (input: {
		readonly base: Session.Position
		readonly value: Option.Option<A>
	}) => StoreEffect<Session.Ref, E, R>
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

/** Contract for plugins that carry persistent schemas. Existing middleware stays independent. */
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
	StoreE = Session.SessionError,
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

/** Contract for building stateful plugins. The host provides the Store service separately. */
export interface Factory {
	readonly make: <
		const I extends Id,
		const Declaration extends StateDeclaration,
		StoreE = Session.SessionError,
		StoreR = Context,
	>(input: {
		readonly id: I
		readonly store: Declaration
	}) => <
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
	>(
		construct: (ctx: {
			readonly store: StoreService<Declaration, StoreE, StoreR, I>
		}) => Effect.Effect<Body<Tools, E, R>, BuildE, BuildR | Scope.Scope>,
	) => Stored<Tools, E, R, Declaration, StoreE, StoreR, I, BuildE, BuildR>
}

/** Contract for composing schemas. PluginComposition provides the production factory. */
export interface StateComposition {
	readonly withStore: <
		Tools extends Record<string, Tool.Any>,
		E,
		R,
		I extends Id,
		Declaration extends StateDeclaration,
		States extends Stores = {},
		BuildE = never,
		BuildR = never,
	>(
		plugin: Plugin<Tools, E, R, BuildE, BuildR> &
			Definition<I> & { readonly stores?: States },
		state: Declaration,
	) => Stateful<
		Tools,
		E,
		R,
		States & Readonly<Record<Brand.Brand.Unbranded<I>, Declaration>>,
		I,
		BuildE,
		BuildR
	>
	readonly merge: <
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LeftE,
		LeftR,
		RightE,
		RightR,
		LeftStates extends Stores,
		RightStates extends Stores,
		I extends Id,
		LeftBuildE = never,
		LeftBuildR = never,
		RightBuildE = never,
		RightBuildR = never,
	>(
		id: I,
		left: Stateful<Left, LeftE, LeftR, LeftStates, Id, LeftBuildE, LeftBuildR>,
		right: Stateful<
			Right,
			RightE,
			RightR,
			RightStates,
			Id,
			RightBuildE,
			RightBuildR
		>,
	) => Effect.Effect<
		Stateful<
			Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
			LeftE | RightE,
			LeftR | RightR,
			LeftStates & RightStates,
			I,
			LeftBuildE | RightBuildE,
			LeftBuildR | RightBuildR
		>,
		StoreConflict
	>
}

export class StoreConflict extends Data.TaggedError("Plugin.StoreConflict")<{
	readonly id: Id
}> {}

/** Parameters that each plugin maps before the final toolkit resolves its handlers. */
export interface Options<
	TK extends Toolkit.Any = Toolkit.Any,
	E = never,
	R = never,
> extends Omit<AgentOptions<Record<string, Tool.Any>>, "toolkit"> {
	readonly toolkit: Effect.Effect<TK, E, R>
	readonly instructions: Prompt.Prompt
}

/** Continues with the mapped toolkit and keeps its construction errors and services. */
export interface Next<E, R> {
	<TK extends Toolkit.Any, ToolkitE, ToolkitR>(
		options: Options<TK, ToolkitE, ToolkitR>,
	): Stream.Stream<Event<Toolkit.MergedTools<[TK]>>, E | ToolkitE, R | ToolkitR>
}

/** Wraps a complete ReAct stream. Tools describes the definitions this middleware adds. */
export interface Middleware<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
> {
	<InputE, InputR, NextE, NextR>(
		next: Next<NextE, NextR>,
		options: Options<Toolkit.Any, InputE, InputR>,
	): Stream.Stream<
		Event<Tools>,
		InputE | NextE | E,
		InputR | NextR | R | Context
	>
}

/** Inference input for a middleware that forwards next generically. */
type Body<Tools extends Record<string, Tool.Any>, E, R> = (
	next: Next<never, never>,
	options: Options,
) => Stream.Stream<Event<Tools>, E, R | Context>

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
	readonly middleware: Effect.Effect<
		Middleware<Tools, E, R>,
		BuildE,
		BuildR | Scope.Scope
	>
}> {
	/** A type-only marker. It keeps concrete tool definitions through generic host factories. */
	declare readonly [ToolsTypeId]?: Tools
}

const makeMiddleware = <
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
		middleware: Effect.suspend(construct).pipe(
			// The callback forwards next generically. Inference uses its empty error and service channels.
			Effect.map((middleware) => middleware as Middleware<Tools, E, R>),
		),
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
	StoreE = Session.SessionError,
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
	StoreE = Session.SessionError,
	StoreR = Context,
>(input: { readonly id: I; readonly store?: D | undefined }) {
	return <
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
	>(
		construct: (ctx: {
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
			const plugin = makeMiddleware(input.id, () => construct({ store }))
			return { ...plugin, store, stores: { [input.id]: definition } }
		}
		return makeMiddleware(input.id, () => construct(undefined!))
	}
}
