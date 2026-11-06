import { Fork, Graft } from "@graftland/graft"
import type { Loader } from "@graftland/loader"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	HashMap,
	Option,
	Schema,
	Stream,
} from "effect"

/** The plugins of a running host and the tree of their forks. */
export interface Service {
	/** Turns plugins on and off, and changes their entries, while the host runs. */
	readonly loader: Loader.Loader["Service"]
	/** The fork tree, now and after each change. */
	readonly forks: Stream.Stream<ReadonlyArray<Fork.ForkTree>>
	/** Ends when no fork has been loading for the quiet time. */
	readonly stable: Effect.Effect<void>
}

export class Composition extends Context.Service<Composition, Service>()(
	"@openbot-build/openbot/Composition",
) {}

/**
 * graft's own `stable` waits only for the forks that load now. A provider can
 * become active while the consumer that it wakes is still waiting, so the tree
 * must stay still for this long.
 */
export const quiet = Duration.millis(250)

/** Startup waits this long at most for every plugin to become active. */
export const startTimeout = Duration.seconds(120)

/** One fork that is not active when it must be. */
export const Inactive = Schema.Struct({
	fork: Schema.Int,
	plugin: Schema.String,
	state: Schema.Literals(["Loading", "Pending", "Failed", "Disposed"]),
	/** The keys that a pending fork waits for. */
	missing: Schema.Array(Schema.String),
	/** The error record of a failed fork, when it has one. */
	errorId: Schema.optionalKey(Schema.String),
})
export type Inactive = typeof Inactive.Type

/** Some plugins did not become active, so the host does not start. */
export class PluginsInactive extends Schema.TaggedError<
	PluginsInactive,
	{ readonly brand: unique symbol }
>()("PluginsInactive", { forks: Schema.Array(Inactive) }) {
	override get message() {
		return `These plugins are not active: ${Arr.join(
			Arr.map(this.forks, (fork) => `${fork.plugin} (${fork.state})`),
			", ",
		)}`
	}
}

/** Every fork of these trees, parents first. */
export const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Arr.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])

/** The forks that are not active, with their error records. */
export const inactive = (
	forks: ReadonlyArray<Fork.ForkTree>,
	errors: HashMap.HashMap<number, string> = HashMap.empty(),
): ReadonlyArray<Inactive> =>
	Arr.flatMap(forks, (fork): ReadonlyArray<Inactive> =>
		fork.state._tag === "Active"
			? []
			: [
					{
						fork: fork.id,
						plugin: fork.name,
						state: fork.state._tag,
						missing: fork.state._tag === "Pending" ? fork.state.missing : [],
						...Option.match(HashMap.get(errors, fork.id), {
							onNone: () => ({}),
							onSome: (errorId) => ({ errorId }),
						}),
					},
				],
	)

const loading = (forks: ReadonlyArray<Fork.ForkTree>) =>
	Arr.some(forks, (fork) => fork.state._tag === "Loading")

/**
 * Ends when no fork in the whole tree has been loading for the quiet time.
 * The engine swap waits on it. It never ends while a fork keeps loading.
 */
export const stable = Graft.forks.pipe(
	Stream.map(flatten),
	Stream.debounce(quiet),
	Stream.filter((forks) => !loading(forks)),
	Stream.runHead,
	Effect.asVoid,
)

/**
 * `stable`, with one warning when it waits longer than `startTimeout`. The
 * warning names the forks that are still loading. While the swap waits, the
 * executions of this node stay paused, so the log must say why.
 */
export const stableOrWarn = stable.pipe(
	Effect.timeoutOrElse({
		duration: startTimeout,
		orElse: () =>
			Stream.runHead(Graft.forks).pipe(
				Effect.flatMap((trees) =>
					Effect.logWarning(
						"Plugins are still loading, so the engine waits. The executions of this node stay paused.",
					).pipe(
						Effect.annotateLogs({
							loading: Arr.join(
								Arr.map(
									Arr.filter(
										flatten(Option.getOrElse(trees, () => [])),
										(fork) => fork.state._tag === "Loading",
									),
									(fork) => `${fork.name} (${fork.id})`,
								),
								", ",
							),
						}),
					),
				),
				// The warning comes one time. Then the wait goes on with no limit.
				Effect.andThen(stable),
			),
	}),
)

export interface SettleOptions {
	/** The top forks to watch. Every fork below them must become active. */
	readonly roots: ReadonlyArray<number>
	/** Gives the error records of failed forks, for the error. */
	readonly errors: Effect.Effect<HashMap.HashMap<number, string>>
	readonly quiet?: Duration.Input | undefined
	readonly timeout?: Duration.Input | undefined
}

/**
 * Waits until every fork in the trees of `roots` is active. It fails with
 * `PluginsInactive` when the trees stay still for the quiet time with no
 * fork loading and some fork not active, or when the time runs out.
 */
export const settle = (options: SettleOptions) =>
	Effect.gen(function* () {
		const watched = Stream.map(Graft.forks, (trees) => {
			const roots = Arr.filter(trees, (tree) =>
				Arr.contains(options.roots, tree.id),
			)
			return {
				forks: flatten(roots),
				// A root that is gone has no fork to wait for, so it can never be active.
				complete: roots.length === options.roots.length,
			}
		})
		const fail = (forks: ReadonlyArray<Fork.ForkTree>) =>
			Effect.flatMap(options.errors, (errors) =>
				Effect.fail(PluginsInactive.make({ forks: inactive(forks, errors) })),
			)
		const active = watched.pipe(
			Stream.filter(
				({ forks, complete }) =>
					complete && Arr.isReadonlyArrayEmpty(inactive(forks)),
			),
			Stream.runHead,
			Effect.asVoid,
		)
		const stuck = watched.pipe(
			Stream.debounce(options.quiet ?? quiet),
			Stream.filter(
				({ forks, complete }) =>
					!loading(forks) &&
					(!complete || Arr.isReadonlyArrayNonEmpty(inactive(forks))),
			),
			Stream.runHead,
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: ({ forks }) => fail(forks),
				}),
			),
			// The stream of a live tree has no end, so this waits for `active` to win.
			Effect.andThen(Effect.never),
		)
		yield* Effect.raceFirst(active, stuck).pipe(
			Effect.timeoutOrElse({
				duration: options.timeout ?? startTimeout,
				orElse: () =>
					Effect.flatMap(Stream.runHead(watched), (current) =>
						fail(
							Option.match(current, {
								onNone: () => [],
								onSome: ({ forks }) => forks,
							}),
						),
					),
			}),
		)
	})
