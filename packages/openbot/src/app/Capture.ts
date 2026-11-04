import { Graft, Plugin as GraftPlugin } from "@graftland/graft"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Option,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { stable } from "./Composition.ts"

/** A capture fork did not get every key it waits for. */
export class CaptureMissing extends Schema.TaggedError<
	CaptureMissing,
	{ readonly brand: unique symbol }
>()("CaptureMissing", {
	/** The name of the capture fork. */
	capture: Schema.String,
	/** The keys that nobody published. */
	missing: Schema.Array(Schema.String),
}) {
	override get message() {
		return `The capture ${this.capture} did not get these keys: ${Arr.join(this.missing, ", ")}`
	}
}

/**
 * Loads a fork that waits for these keys, and gives their services as they
 * are when the fork first starts. The fork lives in the current scope, so it
 * holds the services until the scope closes. When a key is still not
 * published once no fork is loading, it fails with `CaptureMissing`.
 */
export const context = <
	const Keys extends ReadonlyArray<Context.Key<any, any>>,
>(
	name: string,
	keys: Keys,
): Effect.Effect<
	Context.Context<Keys[number]["Identifier"]>,
	CaptureMissing,
	Graft.Graft | Scope.Scope
> =>
	Effect.gen(function* () {
		const captured =
			yield* Deferred.make<Context.Context<Keys[number]["Identifier"]>>()
		const fork = yield* Graft.plugin(
			GraftPlugin.make({
				name,
				inject: keys,
				apply: () =>
					Effect.flatMap(
						Effect.context<Keys[number]["Identifier"]>(),
						(current) =>
							Deferred.succeed(captured, Context.pick(...keys)(current)),
					).pipe(Effect.asVoid),
			}),
		)
		// The keys can come late, so wait until the whole tree is still.
		const missing = Effect.gen(function* () {
			yield* stable
			const done = yield* Deferred.poll(captured)
			if (Option.isSome(done)) return yield* done.value
			const state = yield* Stream.runHead(fork.state)
			return yield* CaptureMissing.make({
				capture: name,
				missing: Option.match(state, {
					onNone: () => [],
					onSome: (state) => (state._tag === "Pending" ? state.missing : []),
				}),
			})
		})
		return yield* Effect.raceFirst(Deferred.await(captured), missing)
	})
