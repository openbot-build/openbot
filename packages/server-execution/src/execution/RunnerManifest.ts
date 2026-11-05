/**
 * The manifest of a runner: what plugins one OpenBot server runs. Each server
 * writes its manifest to `openbot_execution_runners` on a timer, and compares
 * it with the manifests of the other live servers. A different manifest only
 * gives a warning and an error record. It never stops a server.
 */
import { and, eq, gt, lt, ne, sql } from "drizzle-orm"
import { Array as Arr, Duration, Effect, Option, Order, Schema } from "effect"
import * as Db from "@openbot-build/server-database/Database"
import { executionRunners } from "@openbot-build/server-database/ExecutionSchema"

/** One plugin entry as the row keeps it. No config. */
export const Plugin = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	disabled: Schema.Boolean,
})

/** One bot feature and its version. */
export const Feature = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
})

/** What one runner runs. */
export const Manifest = Schema.Struct({
	/** `sha256:<hex>` of the plugin entries. */
	manifestHash: Schema.String,
	/** `sha256:<hex>` of the active forks, the workflows and the bot features. */
	activeHash: Schema.String,
	plugins: Schema.Array(Plugin),
	/** The names of the active plugin forks, sorted. */
	forks: Schema.Array(Schema.String),
	/** The names of the workflows, sorted. */
	workflows: Schema.Array(Schema.String),
	/** The bot features, sorted by id. */
	features: Schema.Array(Feature),
})
export type Manifest = typeof Manifest.Type

/** The hashes of one runner, as an other runner sees them. */
export const Seen = Schema.Struct({
	runnerAddress: Schema.String,
	manifestHash: Schema.String,
	activeHash: Schema.String,
})
export type Seen = typeof Seen.Type

/** A runner is live when it wrote its row in this time. */
export const live = Duration.seconds(90)
/** The rows that nobody wrote in this time are deleted. */
export const expire = Duration.minutes(10)
/** Each runner writes its row this often. */
export const period = Duration.seconds(30)

/** The plugins of this runner are not the same as on other live runners. */
export class ManifestMismatch extends Schema.TaggedError<
	ManifestMismatch,
	{ readonly brand: unique symbol }
>()("ManifestMismatch", {
	runnerAddress: Schema.String,
	manifestHash: Schema.String,
	activeHash: Schema.String,
	others: Schema.Array(Seen),
}) {
	override get message() {
		return "The plugins of this runner are not the same as on other runners."
	}
}

/** What the comparison keeps from one beat to the next. */
export interface State {
	/** The mismatch that was last reported. */
	readonly reported: Option.Option<string>
	/** A mismatch of the active plugins only, seen on the last beat. */
	readonly pending: Option.Option<string>
}

export const initial: State = {
	reported: Option.none(),
	pending: Option.none(),
}

const byAddress = Order.mapInput(
	Order.String,
	(seen: Seen) => seen.runnerAddress,
)

/** The same runners with the same hashes give the same key. */
const key = (others: ReadonlyArray<Seen>) =>
	Arr.join(
		Arr.map(
			Arr.sort(others, byAddress),
			(seen) => `${seen.runnerAddress}=${seen.manifestHash}/${seen.activeHash}`,
		),
		",",
	)

const mismatch = (mine: Seen, others: ReadonlyArray<Seen>) =>
	ManifestMismatch.make({
		runnerAddress: mine.runnerAddress,
		manifestHash: mine.manifestHash,
		activeHash: mine.activeHash,
		others: Arr.sort(others, byAddress),
	})

const same = (a: Option.Option<string>, b: string) =>
	Option.isSome(a) && a.value === b

/**
 * The rule of the comparison. It is pure, and it gives at most one report for
 * each new mismatch:
 *
 * - other entries (a different `manifestHash`) are reported at once;
 * - the same entries with other active plugins are reported only when the
 *   next beat sees the same mismatch, because a plugin that restarts makes a
 *   short one;
 * - when every runner is the same again, the memory is cleared, so a new
 *   mismatch later is reported again.
 */
export const compare = (
	state: State,
	mine: Seen,
	others: ReadonlyArray<Seen>,
): {
	readonly state: State
	readonly report: Option.Option<ManifestMismatch>
} => {
	const drift = Arr.filter(
		others,
		(other) => other.manifestHash !== mine.manifestHash,
	)
	const active = Arr.filter(
		others,
		(other) =>
			other.manifestHash === mine.manifestHash &&
			other.activeHash !== mine.activeHash,
	)
	if (Arr.isReadonlyArrayNonEmpty(drift)) {
		const all = [...drift, ...active]
		const now = key(all)
		return {
			state: { reported: Option.some(now), pending: Option.none() },
			report: same(state.reported, now)
				? Option.none()
				: Option.some(mismatch(mine, all)),
		}
	}
	if (Arr.isReadonlyArrayNonEmpty(active)) {
		const now = key(active)
		if (same(state.reported, now))
			return {
				state: { reported: state.reported, pending: Option.none() },
				report: Option.none(),
			}
		if (same(state.pending, now))
			return {
				state: { reported: Option.some(now), pending: Option.none() },
				report: Option.some(mismatch(mine, active)),
			}
		return {
			state: { reported: state.reported, pending: Option.some(now) },
			report: Option.none(),
		}
	}
	return { state: initial, report: Option.none() }
}

/** A time before the clock of the database. */
const ago = (duration: Duration.Duration) =>
	sql`now() - make_interval(secs => ${Duration.toSeconds(duration)})`

/** The rows of the runners. It needs the database when it is built. */
export const makeStore = Effect.gen(function* () {
	const db = yield* Db.make
	/** Writes the row of this runner, and marks it as seen now. */
	const write = (address: string, processId: string, manifest: Manifest) =>
		db
			.insert(executionRunners)
			.values({ runnerAddress: address, processId, ...manifest })
			.onConflictDoUpdate({
				target: executionRunners.runnerAddress,
				set: {
					processId,
					...manifest,
					// A new process starts a new row. The same process keeps its start time.
					startedAt: sql`case when ${executionRunners.processId} = ${processId}::uuid then ${executionRunners.startedAt} else now() end`,
					seenAt: sql`now()`,
				},
			})
			.pipe(Effect.asVoid)
	/** The hashes of the other live runners. */
	const others = (address: string) =>
		db
			.select({
				runnerAddress: executionRunners.runnerAddress,
				manifestHash: executionRunners.manifestHash,
				activeHash: executionRunners.activeHash,
			})
			.from(executionRunners)
			.where(
				and(
					ne(executionRunners.runnerAddress, address),
					gt(executionRunners.seenAt, ago(live)),
				),
			)
	/** Deletes the rows that nobody wrote for the expiry time. */
	const removeOld = db
		.delete(executionRunners)
		.where(lt(executionRunners.seenAt, ago(expire)))
		.pipe(Effect.asVoid)
	/** Deletes the row of this process only. A new process at the same address keeps its row. */
	const remove = (address: string, processId: string) =>
		db
			.delete(executionRunners)
			.where(
				and(
					eq(executionRunners.runnerAddress, address),
					eq(executionRunners.processId, processId),
				),
			)
			.pipe(Effect.asVoid)
	return { write, others, expire: removeOld, remove }
})

export type Store = Effect.Success<typeof makeStore>
