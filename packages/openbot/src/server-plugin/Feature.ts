/**
 * The kit that turns a feature of OpenBot into a graft plugin.
 *
 * A feature is a chain of stages and one start:
 *
 * - A stage builds a layer of services and publishes every output of it in
 *   one step. Then it loads the next stage, or the start, as its child.
 * - The start builds the work of the feature: its bot features, its
 *   workflows, its workers and its HTTP mounts. It publishes nothing.
 *
 * Each stage and the start is a graft fork of its own. A fork waits until
 * every key in its `inject` list is published, so a later stage can wait for
 * a key that another plugin gives without holding back the keys of the
 * stages before it. A child gets the services of its parents through its
 * closure, not through graft, so it takes no lease on them. When a parent
 * restarts, it closes its child first.
 *
 * Teardown of one fork goes in this order: graft takes back its keys, waits
 * until no consumer holds them, then closes its scope. The scope closes the
 * child first, then the services of the fork.
 */
import { Graft, Plugin as GraftPlugin } from "@graftland/graft"
import { Array as Arr, Context, Effect, Layer, Schedule } from "effect"

/** The keys that a stage or the start waits for. graft's optional keys are not allowed. */
export type Inject = ReadonlyArray<Context.Key<any, any>>

/** The services that an `inject` list gives. */
type Given<I extends Inject> = I[number]["Identifier"]

/** The identifiers of a list of keys. */
type Identifiers<K extends ReadonlyArray<Context.Key<any, any>>> =
	K[number]["Identifier"]

/** A failed stage or start tries again: fast at first, then every 30 seconds. */
export const retry = Schedule.min([
	Schedule.exponential("1 second"),
	Schedule.spaced("30 seconds"),
])

declare const ServicesId: unique symbol

/** A plugin that publishes `Services`. graft does not check this type. */
export type Feature<Services> = GraftPlugin.Plugin & {
	readonly [ServicesId]?: ((_: never) => Services) | undefined
}

/** The services that a feature publishes. */
export type ServicesOf<F> = F extends Feature<infer S> ? S : never

/** The type that a builder gives when a list is wrong. It has no `stage` or `start`. */
export interface Broken<Message extends string, Keys> {
	readonly broken: Message
	readonly keys: (_: never) => Keys
}

/** True when `G` is the same type as one member of `A`. */
type SameAsOne<G, A> = A extends unknown
	? [G] extends [A]
		? [A] extends [G]
			? true
			: false
		: false
	: never

/**
 * The services of `G` that are in `A` too. It compares whole types, because
 * one service type can extend another: `PgClient` extends `SqlClient`.
 */
type Overlap<G, A> = G extends unknown
	? true extends SameAsOne<G, A>
		? G
		: never
	: never

type Fresh<I extends Inject, Avail, Next> = [Overlap<Given<I>, Avail>] extends [
	never,
]
	? Next
	: Broken<
			"These keys are open to this stage already. Take them out of `inject`.",
			Overlap<Given<I>, Avail>
		>

type Covered<ROut, P extends ReadonlyArray<Context.Key<any, any>>, Next> = [
	Exclude<ROut, Identifiers<P>>,
] extends [never]
	? Next
	: Broken<
			"The stage builds these services. Put them in `publishes`.",
			Exclude<ROut, Identifiers<P>>
		>

/**
 * Builds a feature one stage at a time. `Avail` is every service that the
 * next stage can use. `Out` is every service that the feature publishes.
 */
export interface Builder<Avail, Out> {
	/**
	 * Adds a stage. List in `inject` only keys that are new to this feature.
	 * List in `publishes` every output of `services`. Use each layer value in
	 * one stage only: each stage builds its layers again.
	 */
	readonly stage: <
		const I extends Inject,
		ROut,
		E,
		const P extends ReadonlyArray<Context.Key<NoInfer<ROut>, any>>,
	>(stage: {
		/** The name of the fork, after `#`. The default is the number of the stage. */
		readonly name?: string | undefined
		readonly inject: I
		readonly services: Layer.Layer<ROut, E, Avail | Given<I>>
		readonly publishes: P
	}) => Fresh<
		I,
		Avail,
		Covered<ROut, P, Builder<Avail | Given<I> | ROut, Out | ROut>>
	>
	/**
	 * Ends the feature with its work. Build it in this order: bot features,
	 * then workflows, then workers, then HTTP mounts. It closes in the
	 * reverse order, so HTTP stops first and the bot features go last.
	 */
	readonly start: <const I extends Inject, E>(start: {
		readonly inject: I
		readonly layer: Layer.Layer<never, E, Avail | Given<I>>
	}) => Fresh<I, Avail, Feature<Out>>
	/** Ends a feature that has no work of its own: it only publishes services. */
	readonly done: () => Feature<Out>
}

/** One fork of the chain, with its types erased. */
interface Step {
	readonly name: string
	readonly inject: Inject
	readonly layer: Layer.Layer<unknown, unknown, unknown>
	readonly publishes: ReadonlyArray<Context.Key<any, any>>
}

/**
 * The plugin of the first step. Its fork builds the step, publishes its
 * keys in one transaction, and then loads the plugin of the next step with
 * every service so far.
 */
const chain = (
	steps: Arr.NonEmptyReadonlyArray<Step>,
	before: Context.Context<never>,
): GraftPlugin.Plugin => {
	const [step, ...rest] = steps
	return GraftPlugin.make({
		name: step.name,
		inject: step.inject,
		retry,
		apply: () =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope
				// Only the listed keys: the activation also holds graft's own
				// services and log notes, which would cover those of the child.
				const injected = Context.pick(...step.inject)(
					yield* Effect.context<never>(),
				)
				const given = Context.merge(before, injected)
				const built = yield* Layer.buildWithMemoMap(
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a step keeps its layer with the types erased; the builder checked them
					Layer.provide(step.layer, Layer.succeedContext(given)),
					yield* Layer.makeMemoMap,
					scope,
				)
				yield* Effect.tx(
					Effect.forEach(
						step.publishes,
						(key) => Graft.provide(key, Context.get(built, key)),
						{ discard: true },
					),
				)
				if (Arr.isReadonlyArrayNonEmpty(rest))
					yield* Graft.plugin(chain(rest, Context.mergeAll(given, built)))
			}),
	})
}

const builder = (
	name: string,
	steps: ReadonlyArray<Step>,
): Builder<unknown, unknown> => ({
	// Each `as never` erases a type that the types of `Builder` already checked.
	stage: (stage) =>
		builder(name, [
			...steps,
			{
				name: Arr.isReadonlyArrayEmpty(steps)
					? name
					: `${name}#${stage.name ?? steps.length}`,
				inject: stage.inject,
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a step keeps its layer with the types erased
				layer: stage.services as Layer.Layer<unknown, unknown, unknown>,
				publishes: stage.publishes,
			},
		]) as never,
	start: (start) =>
		chain(
			Arr.append(steps, {
				name: Arr.isReadonlyArrayEmpty(steps) ? name : `${name}#start`,
				inject: start.inject,
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a step keeps its layer with the types erased
				layer: start.layer as Layer.Layer<unknown, unknown, unknown>,
				publishes: [],
			}),
			Context.empty(),
		) as never,
	done: () =>
		chain(
			Arr.isReadonlyArrayNonEmpty(steps)
				? steps
				: Arr.of<Step>({
						name,
						inject: [],
						// A step keeps its layer with the types erased.
						layer: Layer.empty as never,
						publishes: [],
					}),
			Context.empty(),
		) as never,
})

/**
 * Starts a feature. The first stage, or the start when there is no stage,
 * is the fork with this name.
 */
export const make = (name: string): Builder<never, never> =>
	// The types of each later call check the stages, so the empty start can take any type.
	builder(name, []) as unknown as Builder<never, never>

/**
 * Builds the layers of a start one after another, in the order of the list,
 * and closes them in the reverse order. Give them in this order: bot
 * features, workflows, workers, HTTP mounts.
 */
export const inOrder = <
	const L extends Arr.NonEmptyReadonlyArray<
		Layer.Layer<never, unknown, unknown>
	>,
>(
	...layers: L
): Layer.Layer<never, Layer.Error<L[number]>, Layer.Services<L[number]>> =>
	// The list is a tuple of layers, so its items are layers of these types.
	sequence<Layer.Error<L[number]>, Layer.Services<L[number]>>(layers as never)

const sequence = <E, R>(
	layers: Arr.NonEmptyReadonlyArray<Layer.Layer<never, E, R>>,
): Layer.Layer<never, E, R> =>
	// Each layer gives nothing, so the order of the build is the only effect of `provideMerge` here.
	Arr.reduce(
		Arr.tailNonEmpty(layers),
		Arr.headNonEmpty(layers),
		(built, next) => next.pipe(Layer.provideMerge(built)),
	)
