import { Effect, Record as Rec, Stream, type Brand, Scope } from "effect"
import { dual } from "effect/Function"
import { Prompt, Toolkit, type Tool } from "effect/ai"
import { Context, type Event } from "../bot/Bot.ts"
import {
	Id,
	Plugin,
	StoreConflict,
	type Next,
	type Options,
	type StateDeclaration,
	type Stateful,
	type Stores,
} from "./Plugin.ts"

export const withStore: {
	<D extends StateDeclaration>(
		state: D,
	): <
		Tools extends Record<string, Tool.Any>,
		E,
		R,
		I extends Id,
		States extends Stores = {},
		BuildE = never,
		BuildR = never,
	>(
		plugin: Plugin<Tools, E, R, BuildE, BuildR> & {
			readonly id: I
			readonly stores?: States
		},
	) => Stateful<
		Tools,
		E,
		R,
		States & Readonly<Record<Brand.Brand.Unbranded<I>, D>>,
		I,
		BuildE,
		BuildR
	>
	<
		Tools extends Record<string, Tool.Any>,
		E,
		R,
		I extends Id,
		D extends StateDeclaration,
		States extends Stores = {},
		BuildE = never,
		BuildR = never,
	>(
		plugin: Plugin<Tools, E, R, BuildE, BuildR> & {
			readonly id: I
			readonly stores?: States
		},
		state: D,
	): Stateful<
		Tools,
		E,
		R,
		States & Readonly<Record<Brand.Brand.Unbranded<I>, D>>,
		I,
		BuildE,
		BuildR
	>
} = dual(
	2,
	<
		Tools extends Record<string, Tool.Any>,
		E,
		R,
		I extends Id,
		D extends StateDeclaration,
		States extends Stores = {},
		BuildE = never,
		BuildR = never,
	>(
		plugin: Plugin<Tools, E, R, BuildE, BuildR> & {
			readonly id: I
			readonly stores?: States
		},
		state: D,
	): Stateful<
		Tools,
		E,
		R,
		States & Readonly<Record<Brand.Brand.Unbranded<I>, D>>,
		I,
		BuildE,
		BuildR
	> =>
		// A spread would copy only the own fields and lose the methods of Plugin,
		// such as `pipe`. So the fields go on a new Plugin.
		Object.assign(
			new Plugin<Tools, E, R, BuildE, BuildR>({
				id: plugin.id,
				middleware: plugin.middleware,
			}),
			plugin,
			{
				stores: { ...plugin.stores, [plugin.id]: state } as States &
					Readonly<Record<Brand.Brand.Unbranded<I>, D>>,
			},
		),
)

export const mergeState: {
	<
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LE,
		LR,
		RE,
		RR,
		LS extends Stores,
		RS extends Stores,
		LBE,
		LBR,
		RBE,
		RBR,
	>(
		left: Stateful<Left, LE, LR, LS, Id, LBE, LBR>,
		right: Stateful<Right, RE, RR, RS, Id, RBE, RBR>,
	): <I extends Id>(
		id: I,
	) => Effect.Effect<
		Stateful<
			Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
			LE | RE,
			LR | RR,
			LS & RS,
			I,
			LBE | RBE,
			Exclude<LBR | RBR, Scope.Scope>
		>,
		StoreConflict
	>
	<
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LE,
		LR,
		RE,
		RR,
		LS extends Stores,
		RS extends Stores,
		LBE,
		LBR,
		RBE,
		RBR,
		I extends Id,
	>(
		id: I,
		left: Stateful<Left, LE, LR, LS, Id, LBE, LBR>,
		right: Stateful<Right, RE, RR, RS, Id, RBE, RBR>,
	): Effect.Effect<
		Stateful<
			Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
			LE | RE,
			LR | RR,
			LS & RS,
			I,
			LBE | RBE,
			Exclude<LBR | RBR, Scope.Scope>
		>,
		StoreConflict
	>
} = dual(
	3,
	<
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LE,
		LR,
		RE,
		RR,
		LS extends Stores,
		RS extends Stores,
		LBE,
		LBR,
		RBE,
		RBR,
		I extends Id,
	>(
		id: I,
		left: Stateful<Left, LE, LR, LS, Id, LBE, LBR>,
		right: Stateful<Right, RE, RR, RS, Id, RBE, RBR>,
	): Effect.Effect<
		Stateful<
			Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
			LE | RE,
			LR | RR,
			LS & RS,
			I,
			LBE | RBE,
			Exclude<LBR | RBR, Scope.Scope>
		>,
		StoreConflict
	> =>
		Effect.gen(function* () {
			for (const key of Rec.keys(left.stores))
				if (Rec.has(right.stores, key))
					return yield* StoreConflict.make({ id: Id.make(key) })
			// `merge` gives a new Plugin, so the stores go on it and it keeps its methods.
			return Object.assign(merge(left, right), {
				id,
				stores: { ...left.stores, ...right.stores },
			})
		}),
)

/** Composes left outside right. Each middleware maps parameters at run time. */
export const merge: {
	<
		Right extends Record<string, Tool.Any>,
		RightE,
		RightR,
		RightBuildE,
		RightBuildR,
	>(
		right: Plugin<Right, RightE, RightR, RightBuildE, RightBuildR>,
	): <
		Left extends Record<string, Tool.Any>,
		LeftE,
		LeftR,
		LeftBuildE,
		LeftBuildR,
	>(
		left: Plugin<Left, LeftE, LeftR, LeftBuildE, LeftBuildR>,
	) => Plugin<
		Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
		LeftE | RightE,
		LeftR | RightR,
		LeftBuildE | RightBuildE,
		Exclude<LeftBuildR | RightBuildR, Scope.Scope>
	>
	<
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LeftE,
		LeftR,
		RightE,
		RightR,
		LeftBuildE,
		LeftBuildR,
		RightBuildE,
		RightBuildR,
	>(
		left: Plugin<Left, LeftE, LeftR, LeftBuildE, LeftBuildR>,
		right: Plugin<Right, RightE, RightR, RightBuildE, RightBuildR>,
	): Plugin<
		Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
		LeftE | RightE,
		LeftR | RightR,
		LeftBuildE | RightBuildE,
		Exclude<LeftBuildR | RightBuildR, Scope.Scope>
	>
} = dual(
	2,
	<
		Left extends Record<string, Tool.Any>,
		Right extends Record<string, Tool.Any>,
		LeftE,
		LeftR,
		RightE,
		RightR,
		LeftBuildE,
		LeftBuildR,
		RightBuildE,
		RightBuildR,
	>(
		left: Plugin<Left, LeftE, LeftR, LeftBuildE, LeftBuildR>,
		right: Plugin<Right, RightE, RightR, RightBuildE, RightBuildR>,
	) =>
		new Plugin<
			Toolkit.MergedTools<[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]>,
			LeftE | RightE,
			LeftR | RightR,
			LeftBuildE | RightBuildE,
			Exclude<LeftBuildR | RightBuildR, Scope.Scope>
		>({
			id: Id.make(left.id + "+" + right.id),
			middleware: Effect.gen(function* () {
				const scope = yield* Effect.scope
				const leftMiddleware = yield* left.middleware.pipe(
					Effect.provideService(Scope.Scope, scope),
				)
				const rightMiddleware = yield* right.middleware.pipe(
					Effect.provideService(Scope.Scope, scope),
				)
				return <InputE, InputR, NextE, NextR>(
					next: Next<NextE, NextR>,
					options: Options<Toolkit.Any, InputE, InputR>,
				) =>
					Stream.suspend(() =>
						leftMiddleware<
							InputE,
							InputR,
							NextE | RightE,
							NextR | RightR | Context
						>(
							<TK extends Toolkit.Any, ToolkitE, ToolkitR>(
								inner: Options<TK, ToolkitE, ToolkitR>,
							) =>
								Stream.unwrap(
									Effect.map(Context, (context) => {
										const { toolkit: _, instructions, ...runOptions } = inner
										return Context.provide(
											Stream.suspend(() =>
												rightMiddleware<ToolkitE, ToolkitR, NextE, NextR>(
													next,
													inner,
												),
											).pipe(
												// The continuation carries all tools so far. Each plugin records only its own additions.
												Stream.map(
													(event) => event as Event<Toolkit.MergedTools<[TK]>>,
												),
											),
											{
												...context,
												options: runOptions,
												history: Effect.flatMap(context.step, (step) =>
													step === 0
														? Effect.succeed(
																Prompt.concat(instructions, inner.prompt),
															)
														: context.history,
												),
											},
										)
									}),
								),
							options,
						).pipe(
							Stream.map(
								(event) =>
									event as Event<
										Toolkit.MergedTools<
											[Toolkit.Toolkit<Left>, Toolkit.Toolkit<Right>]
										>
									>,
							),
						),
					)
			}),
		}),
)
