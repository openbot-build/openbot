import { PgClient } from "@effect/sql-pg"
import { and, eq, isNull } from "drizzle-orm"
import {
	Array as Arr,
	Context,
	Data,
	Deferred,
	PubSub,
	RcMap,
	Schedule,
	Stream,
	Cause,
	Ref,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { RunnerStorage, ShardingConfig } from "effect/cluster"
import * as Db from "../database/Database.ts"
import { resourceLeases, resourceOwners } from "../database/ResourceSchema.ts"
import { storage, transactionFailures } from "../execution/Store.ts"
import * as Background from "../execution/Background.ts"
import * as Resource from "./Resource.ts"

class ResourceKey extends Data.Class<
	Resource.Ref & { readonly afterLease: string | null }
> {}

const make = Effect.gen(function* () {
	const background = yield* Background.make
	const db = yield* Db.make
	const sql = yield* PgClient.PgClient
	const transactions = yield* SqlClient.SqlClient
	const crypto = yield* Crypto.Crypto
	const runners = yield* RunnerStorage.RunnerStorage
	const config = yield* ShardingConfig.ShardingConfig
	if (Option.isNone(config.runnerAddress))
		return yield* Effect.die("Physical resources need a runner address.")
	const own = config.runnerAddress.value
	const node = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
	const where = (ref: Resource.Ref) =>
		and(
			eq(resourceOwners.namespace, ref.namespace),
			eq(resourceOwners.kind, ref.kind),
			eq(resourceOwners.id, ref.id),
		)
	const alive = (address: Resource.Address) =>
		runners.getRunners.pipe(
			Effect.map((all) =>
				Arr.some(
					all,
					([runner, healthy]) =>
						healthy &&
						runner.address.host === address.host &&
						runner.address.port === address.port,
				),
			),
			storage,
		)
	const load = (ref: Resource.Ref) =>
		db
			.select()
			.from(resourceOwners)
			.where(where(ref))
			.pipe(Effect.map(Arr.head), storage)
	const resultCodec = Schema.fromJsonString(Resource.ReleaseResult)
	const find = (ref: Resource.Ref) =>
		Effect.gen(function* () {
			const found = yield* load(ref)
			if (Option.isNone(found) || !(yield* alive(found.value)))
				return Option.none()
			return found
		})
	const wake = yield* PubSub.sliding<void>(1)
	// Notifications are hints. One timer covers lost hints for all resource readers.
	yield* background.repeat(PubSub.publish(wake, undefined), {
		schedule: Schedule.spaced("1 second"),
		message: "Resource readers could not be woken.",
	})
	yield* background.repeat(
		Effect.scoped(
			sql
				.listen("openbot_resources")
				.pipe(
					Effect.flatMap((queue) =>
						Stream.fromQueue(queue).pipe(
							Stream.runForEach(() => PubSub.publish(wake, undefined)),
						),
					),
				),
		),
		{
			schedule: Schedule.spaced("1 second"),
			message: "Resource notices were lost.",
		},
	)
	const readers = yield* RcMap.make({
		lookup: (ref: ResourceKey) =>
			Effect.gen(function* () {
				// Subscribe before the first read, so a concurrent claim cannot be missed.
				const notices = yield* PubSub.subscribe(wake)
				const found = yield* Deferred.make<
					Resource.Address,
					Effect.Error<ReturnType<typeof find>>
				>()
				yield* Effect.gen(function* () {
					while (true) {
						const current = yield* find(ref)
						if (
							Option.isSome(current) &&
							current.value.lease !== ref.afterLease
						)
							return current.value
						yield* PubSub.take(notices)
					}
				}).pipe(Deferred.into(found), Effect.forkScoped)
				return found
			}),
		idleTimeToLive: "0 millis",
	})
	const wait = (ref: Resource.Ref, afterLease?: string) =>
		Effect.scoped(
			RcMap.get(
				readers,
				new ResourceKey({ ...ref, afterLease: afterLease ?? null }),
			).pipe(Effect.flatMap(Deferred.await)),
		)
	// A TCP address belongs to this new process now. Old sockets at that address are gone.
	yield* db
		.delete(resourceOwners)
		.where(
			and(eq(resourceOwners.host, own.host), eq(resourceOwners.port, own.port)),
		)
		.pipe(storage)
	yield* Effect.addFinalizer(() =>
		db
			.delete(resourceOwners)
			.where(eq(resourceOwners.node, node))
			.pipe(
				background.logFailure(
					"The resource directory could not close this node.",
				),
			),
	)
	const prepare = (ref: Resource.Ref) =>
		Effect.map(
			crypto.randomUUIDv4().pipe(Effect.orDie),
			(lease): Resource.Address => ({
				...ref,
				lease,
				node,
				host: own.host,
				port: own.port,
			}),
		)
	const lock = (ref: Resource.Ref) =>
		Schema.encodeEffect(Schema.fromJsonString(Resource.Ref))(ref).pipe(
			Effect.orDie,
			Effect.flatMap(
				(key) => sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
			),
		)
	const claim = Effect.fn("ResourceDirectory.claim")(function* <E = never>(
		address: Resource.Address,
		replace: boolean,
		admit: Effect.Effect<void, E> = Effect.void,
	) {
		const previous = yield* Ref.make(Option.none<Resource.Address>())
		const commit = transactions
			.withTransaction(
				Effect.gen(function* () {
					yield* admit
					yield* lock(address)
					const found = yield* find(address)
					if (Option.isSome(found) && found.value.lease === address.lease)
						return
					if (Option.isSome(found) && !replace)
						return yield* Resource.Busy.make({ resource: address })
					yield* Ref.set(previous, found)
					yield* db.insert(resourceLeases).values(address).onConflictDoNothing()
					yield* db
						.insert(resourceOwners)
						.values(address)
						.onConflictDoUpdate({
							target: [
								resourceOwners.namespace,
								resourceOwners.kind,
								resourceOwners.id,
							],
							set: address,
						})
					yield* sql`select pg_notify('openbot_resources', '')`
				}),
			)
			.pipe(transactionFailures)
		yield* commit.pipe(
			Effect.catchCauseIf(
				(cause) => !Cause.hasInterruptsOnly(cause),
				// A lost COMMIT reply does not mean that the claim was rolled back.
				(cause) =>
					load(address).pipe(
						Effect.catchCause((readCause) =>
							Effect.failCause(Cause.combine(cause, readCause)),
						),
						Effect.flatMap((found) =>
							Option.isSome(found) && found.value.lease === address.lease
								? Effect.void
								: Effect.failCause(cause),
						),
					),
			),
		)
		return { address, previous: yield* Ref.get(previous) }
	})
	const release = (address: Resource.Address) =>
		db
			.delete(resourceOwners)
			.where(
				and(
					where(address),
					eq(resourceOwners.lease, address.lease),
					eq(resourceOwners.node, address.node),
				),
			)
			.returning({ id: resourceOwners.id })
			.pipe(
				Effect.map((rows) => rows.length > 0),
				storage,
			)
	const current = (address: Resource.Address) =>
		Effect.gen(function* () {
			const found = yield* find(address)
			return (
				Option.isSome(found) &&
				found.value.lease === address.lease &&
				found.value.node === address.node
			)
		})
	/** Commit feature state only for this lease. The change must contain no outside I/O. */
	const commit = <A, E>(
		address: Resource.Address,
		change: Effect.Effect<A, E>,
	) =>
		transactions
			.withTransaction(
				Effect.gen(function* () {
					yield* lock(address)
					if (!(yield* current(address))) return Option.none<A>()
					return Option.some(yield* change)
				}),
			)
			.pipe(transactionFailures)
	/** This uses all leases, including an old owner that no longer has a route. */
	const leases = (
		ref: Pick<Resource.Ref, "namespace" | "kind"> & { readonly id?: string },
	) =>
		db
			.select()
			.from(resourceLeases)
			.where(
				and(
					eq(resourceLeases.namespace, ref.namespace),
					eq(resourceLeases.kind, ref.kind),
					ref.id === undefined ? undefined : eq(resourceLeases.id, ref.id),
				),
			)
			.pipe(storage)
	const released = (address: Resource.Address) =>
		Effect.gen(function* () {
			const found = yield* db
				.select()
				.from(resourceLeases)
				.where(
					and(
						eq(resourceLeases.lease, address.lease),
						eq(resourceLeases.node, address.node),
					),
				)
				.pipe(Effect.map(Arr.head), storage)
			if (Option.isNone(found) || found.value.result === null)
				return Option.none()
			return Option.some(
				yield* Schema.decodeEffect(resultCodec)(found.value.result).pipe(
					storage,
				),
			)
		})
	const complete = (
		address: Resource.Address,
		result: Resource.ReleaseResult,
	) =>
		Effect.gen(function* () {
			const encoded =
				yield* Schema.encodeEffect(resultCodec)(result).pipe(storage)
			// First result wins. A later retry must not erase a failed physical close.
			yield* db
				.update(resourceLeases)
				.set({ result: encoded })
				.where(
					and(
						eq(resourceLeases.lease, address.lease),
						eq(resourceLeases.node, address.node),
						isNull(resourceLeases.result),
					),
				)
				.pipe(storage)
		})
	const lost = (address: Resource.Address) =>
		Effect.scoped(
			Effect.gen(function* () {
				const notices = yield* PubSub.subscribe(wake)
				while (yield* current(address)) yield* PubSub.take(notices)
			}),
		)
	const list = (group: Pick<Resource.Ref, "namespace" | "kind">) =>
		Effect.gen(function* () {
			const rows = yield* db
				.select()
				.from(resourceOwners)
				.where(
					and(
						eq(resourceOwners.namespace, group.namespace),
						eq(resourceOwners.kind, group.kind),
					),
				)
				.pipe(storage)
			const all = yield* runners.getRunners.pipe(storage)
			return Arr.filter(rows, (address) =>
				Arr.some(
					all,
					([runner, healthy]) =>
						healthy &&
						runner.address.host === address.host &&
						runner.address.port === address.port,
				),
			)
		})
	return {
		node,
		prepare,
		claim,
		release,
		find,
		current,
		commit,
		list,
		wait,
		leases,
		released,
		complete,
		lost,
	}
})

/** Node health comes from the execution engine. There is no second heartbeat. */
export class Directory extends Context.Service<
	Directory,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/resources/Directory") {}
export const layer = Layer.effect(Directory, make)
