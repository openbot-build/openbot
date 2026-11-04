import { type Fork, Graft } from "@graftland/graft"
import {
	Array as Arr,
	Context,
	Effect,
	HashMap,
	Option,
	Ref,
	Semaphore,
	Stream,
	type Scope,
} from "effect"
import * as Report from "../server-kernel/errors/Report.ts"
import * as Background from "../server-kernel/execution/Background.ts"
import { flatten } from "./Composition.ts"

/** Saves the cause of each failed plugin fork in the error records. */
export interface Service {
	/** Saves failures until the scope closes. */
	readonly watch: Effect.Effect<void, never, Scope.Scope>
	/**
	 * Saves the failures of the tree as it is now, and gives the error record
	 * of each failed fork.
	 */
	readonly flush: Effect.Effect<HashMap.HashMap<number, string>>
}

export class PluginFailures extends Context.Service<PluginFailures, Service>()(
	"@openbot-build/openbot/app/PluginFailures",
) {}

/**
 * A fork gets one record for each time it fails. A fork that tries again
 * fails with a new cause each time, so the record stays until the fork is
 * active again or gone.
 */
export const make = Effect.gen(function* () {
	const report = yield* Report.make
	const forks = Graft.forks.pipe(
		Stream.provideService(Graft.Graft, yield* Graft.Graft),
	)
	const lock = yield* Semaphore.make(1)
	const recorded = yield* Ref.make(HashMap.empty<number, string>())
	const save = (fork: Fork.ForkTree, cause: unknown) =>
		Effect.gen(function* () {
			const failure = yield* report(`plugin ${fork.name}`, cause)
			// The log has the record id only. The cause is in the record.
			yield* Effect.logError("A plugin failed.").pipe(
				Effect.annotateLogs({
					plugin: fork.name,
					fork: fork.id,
					errorId: failure.errorId,
				}),
			)
			return Option.some<string>(failure.errorId)
		}).pipe(
			Effect.catchCause((cause) =>
				Background.beforeStorage
					.logFailure("A plugin failure could not be saved.")(
						Effect.failCause(cause),
					)
					.pipe(Effect.as(Option.none<string>())),
			),
		)
	const check = (trees: ReadonlyArray<Fork.ForkTree>) =>
		Semaphore.withPermits(
			lock,
			1,
		)(
			Effect.gen(function* () {
				const before = yield* Ref.get(recorded)
				const kept = yield* Effect.forEach(flatten(trees), (fork) =>
					Effect.gen(function* () {
						const known = HashMap.get(before, fork.id)
						if (fork.state._tag === "Active") return Option.none()
						if (fork.state._tag !== "Failed" || Option.isSome(known))
							return Option.map(known, (errorId) => [fork.id, errorId] as const)
						const saved = yield* save(fork, fork.state.cause)
						return Option.map(saved, (errorId) => [fork.id, errorId] as const)
					}),
				)
				return yield* Ref.setAndGet(
					recorded,
					HashMap.fromIterable(Arr.getSomes(kept)),
				)
			}),
		)
	return PluginFailures.of({
		watch: forks.pipe(
			Stream.runForEach(check),
			Background.beforeStorage.logFailure(
				"The watch of plugin failures stopped.",
			),
			Effect.forkScoped,
			Effect.asVoid,
		),
		flush: Effect.flatMap(Stream.runHead(forks), (trees) =>
			check(Option.getOrElse(trees, () => [])),
		),
	})
})
