/**
 * The manifest of this runner and its heartbeat. Every server must run the
 * same plugins, so each server writes what it runs to the database, and warns
 * when another live server runs something different. The warning never stops
 * a server: during a rolling change, servers are different for a short time.
 */
import { type Fork, Graft } from "@graftland/graft"
import type { Entry } from "@graftland/loader"
import {
	Array as Arr,
	Effect,
	Option,
	Order,
	Ref,
	Result,
	Schedule,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import * as RunnerManifest from "../server-execution/execution/RunnerManifest.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import * as Background from "../server-kernel/execution/Background.ts"
import * as Report from "../server-kernel/errors/Report.ts"
import * as Composition from "./Composition.ts"
import * as PluginsFile from "./PluginsFile.ts"

/** The forks of these roots that are active, by name, sorted and once each. */
export const activeForks = (
	trees: ReadonlyArray<Fork.ForkTree>,
	roots: ReadonlyArray<number>,
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.filterMap(
				Composition.flatten(
					Arr.filter(trees, (tree) => Arr.contains(roots, tree.id)),
				),
				(fork) =>
					fork.state._tag === "Active"
						? Result.succeed(fork.name)
						: Result.failVoid,
			),
		),
		Order.String,
	)

export interface Options {
	/** The private address of this runner, as `host:port`. */
	readonly address: string
	/** The entries of the loader now. An edit at run time counts. */
	readonly entries: Effect.Effect<ReadonlyArray<Entry.Entry>>
	/**
	 * The forks whose trees hold the plugins. Only forks below them count, so
	 * the forks of the host itself do not change the hash.
	 */
	readonly roots: ReadonlyArray<number>
}

/**
 * Writes the row of this runner now and then every `RunnerManifest.period`,
 * and compares it with the rows of the other live runners. When the scope
 * closes, it stops and deletes its own row. A failed beat goes to the error
 * records, and the next beat runs as normal. It never fails the start.
 */
export const heartbeat = (options: Options) =>
	Effect.gen(function* () {
		const graft = yield* Graft.Graft
		const workflows = yield* Workflows
		const features = yield* BotFeatures
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const store = yield* RunnerManifest.makeStore
		const report = yield* Report.make
		const background = yield* Background.make
		// A short-lived id: it only tells this process from a later one at the same address.
		const processId = yield* random.uuidV4()
		const state = yield* Ref.make(RunnerManifest.initial)

		const sha256 = (value: unknown) =>
			digest
				.digestHex(
					Digest.sha256,
					new TextEncoder().encode(PluginsFile.canonical(value)),
				)
				.pipe(Effect.map((hex) => `sha256:${hex}`))

		const current = Effect.gen(function* () {
			const entries = yield* options.entries
			const trees = yield* Stream.runHead(
				Graft.forks.pipe(Stream.provideService(Graft.Graft, graft)),
			)
			const forks = activeForks(
				Option.getOrElse(trees, () => []),
				options.roots,
			)
			const names = Arr.sort(yield* workflows.names, Order.String)
			const pins = Arr.sort(
				Arr.map(yield* features.snapshot, (pin) => ({
					id: pin.id,
					version: pin.version,
				})),
				Order.mapInput(Order.String, (pin: { readonly id: string }) => pin.id),
			)
			const manifest: RunnerManifest.Manifest = {
				manifestHash: yield* PluginsFile.manifestHash(entries).pipe(
					Effect.provideService(Digest.Digest, digest),
				),
				activeHash: yield* sha256({
					version: 1,
					forks,
					workflows: names,
					features: pins,
				}),
				plugins: Arr.map(PluginsFile.show(entries), (entry) => ({
					id: entry.id,
					name: entry.name,
					disabled: entry.disabled,
				})),
				forks,
				workflows: names,
				features: pins,
			}
			return manifest
		})

		const beat = Effect.gen(function* () {
			const manifest = yield* current
			yield* store.write(options.address, processId, manifest)
			yield* store.expire
			const others = yield* store.others(options.address)
			const result = RunnerManifest.compare(
				yield* Ref.get(state),
				{
					runnerAddress: options.address,
					manifestHash: manifest.manifestHash,
					activeHash: manifest.activeHash,
				},
				others,
			)
			yield* Ref.set(state, result.state)
			if (Option.isNone(result.report)) return
			const failure = yield* report("runner manifest", result.report.value)
			// Ids and hashes only: config never goes into the log.
			yield* Effect.logWarning(
				"The plugins of this runner are not the same as on other runners. Give every runner the same plugins file and the same image.",
			).pipe(
				Effect.annotateLogs({
					errorId: failure.errorId,
					runnerAddress: options.address,
					manifestHash: manifest.manifestHash,
					activeHash: manifest.activeHash,
					others: Arr.map(
						result.report.value.others,
						(other) => other.runnerAddress,
					),
				}),
			)
		})

		// Added before the loop, so it runs after the loop stops.
		yield* Effect.addFinalizer(() =>
			background.logFailure("The runner row could not be removed.")(
				store.remove(options.address, processId),
			),
		)
		yield* background.repeat(beat, {
			schedule: Schedule.spaced(RunnerManifest.period),
			message: "The runner manifest could not be written.",
		})
	})
