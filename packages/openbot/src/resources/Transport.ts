import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Crypto,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import { Records } from "../errors/Records.ts"
import * as Background from "../execution/Background.ts"
import * as PrivateRpc from "../transport/PrivateRpc.ts"
import { Directory } from "./Directory.ts"
import * as Resource from "./Resource.ts"

export const path = "/internal/resources/rpc"

/** These messages are never put in the engine message store. Features validate their input. */
export class Protocol extends RpcGroup.make(
	Rpc.make("Call", {
		payload: { address: Resource.Address, input: Schema.Json },
		success: Schema.Json,
		error: Resource.Error,
		stream: true,
	}),
	Rpc.make("Exists", {
		payload: { address: Resource.Address },
		success: Schema.Boolean,
	}),
	Rpc.make("Release", {
		payload: { address: Resource.Address },
		success: Schema.Void,
		error: Resource.Error,
	}),
	Rpc.make("Close", {
		payload: { address: Resource.Address },
		success: Schema.Void,
	}),
) {}

export type Handler<E = Resource.Error> = (
	input: Schema.Json,
) => Stream.Stream<Schema.Json, E>
/** Stop the handler before waiting for the error store. */
class ConnectionLost extends Schema.TaggedError<
	ConnectionLost,
	{ readonly brand: unique symbol }
>()("ResourceConnectionLost", { resource: Resource.Ref }) {}

interface Local {
	readonly handler: Handler
	readonly released: Effect.Effect<void, Resource.Error>
	readonly lost: Deferred.Deferred<void>
	readonly admission: Ref.Ref<{
		readonly open: boolean
		readonly count: number
	}>
	readonly close: Effect.Effect<void>
}

const make = Effect.gen(function* () {
	const background = yield* Background.make
	const directory = yield* Directory
	const http = yield* HttpClient.HttpClient
	const serialization = yield* RpcSerialization.RpcSerialization
	const errors = yield* Records
	const crypto = yield* Crypto.Crypto
	const locals = yield* Ref.make(HashMap.empty<string, Local>())
	const pendingCloses = yield* Ref.make(
		HashMap.empty<string, Effect.Effect<void, Resource.Error>>(),
	)
	const failed = (
		resource: Resource.Ref,
		outcome: "not_sent" | "unknown",
		cause: Cause.Cause<unknown>,
	) =>
		Effect.gen(function* () {
			if (Cause.hasInterruptsOnly(cause))
				return yield* Effect.failCause(
					Cause.fromReasons<never>(
						Arr.filter(cause.reasons, Cause.isInterruptReason),
					),
				)
			const failure = yield* errors.record(cause, "unavailable").pipe(
				Effect.catchCause((recordCause) =>
					Effect.gen(function* () {
						if (Cause.hasInterruptsOnly(recordCause))
							return yield* Effect.failCause(
								Cause.fromReasons<never>(
									Arr.filter(recordCause.reasons, Cause.isInterruptReason),
								),
							)
						const errorId = Execution.ErrorId.make(
							yield* crypto.randomUUIDv4().pipe(Effect.orDie),
						)
						// Records keeps both causes in its StorageError when it cannot seal them.
						yield* Effect.logError(
							"A private resource error could not be stored.",
							recordCause,
						).pipe(Effect.annotateLogs({ errorId }))
						return { errorId, category: "unavailable" as const }
					}),
				),
			)
			return yield* Resource.Failed.make({ resource, outcome, failure })
		})
	const safe =
		(resource: Resource.Ref, outcome: "not_sent" | "unknown") =>
		(cause: Cause.Cause<unknown>): Effect.Effect<never, Resource.Error> => {
			const reason = cause.reasons[0]
			if (
				cause.reasons.length === 1 &&
				reason?._tag === "Fail" &&
				Schema.is(Resource.Error)(reason.error)
			) {
				const error = reason.error
				return Effect.failCause(Cause.map(cause, () => error))
			}
			return failed(resource, outcome, cause)
		}
	const safeCloseFailure = (
		resource: Resource.Ref,
		cause: Cause.Cause<Resource.Error>,
	) =>
		Effect.gen(function* () {
			const reason = cause.reasons[0]
			if (reason?._tag === "Fail" && reason.error._tag === "ResourceFailed")
				return reason.error.failure
			return yield* errors
				.record(cause, "unavailable")
				.pipe(Effect.catchCause(safe(resource, "unknown")))
		})
	const closeResult = (
		address: Resource.Address,
		work: Effect.Effect<void, Resource.Error>,
	) =>
		Effect.gen(function* () {
			const exit = yield* work.pipe(
				Effect.catchCause(safe(address, "unknown")),
				Effect.exit,
			)
			const result: Resource.ReleaseResult = Exit.isSuccess(exit)
				? { _tag: "Closed" }
				: {
						_tag: "Failed",
						failure: yield* safeCloseFailure(address, exit.cause),
					}
			// Keep a known close while its save can fail. A later Release retries only this save.
			const save = directory.complete(address, result).pipe(
				Effect.catchCause(safe(address, "unknown")),
				Effect.tap(() =>
					Ref.update(pendingCloses, HashMap.remove(address.lease)),
				),
				Effect.andThen(exit),
			)
			yield* Ref.update(pendingCloses, HashMap.set(address.lease, save))
			return yield* save
		})

	const client = (address: Resource.Address) =>
		Effect.gen(function* () {
			const host = Str.includes(":")(address.host)
				? `[${address.host}]`
				: address.host
			const protocol = yield* RpcClient.makeProtocolHttp(
				HttpClient.mapRequest(
					http,
					HttpClientRequest.prependUrl(`http://${host}:${address.port}${path}`),
				),
			)
			return yield* RpcClient.make(Protocol).pipe(
				Effect.provideService(RpcClient.Protocol, protocol),
			)
		}).pipe(
			Effect.provideService(RpcSerialization.RpcSerialization, serialization),
		)
	const closeLocal = (address: Resource.Address) =>
		Effect.gen(function* () {
			const local = HashMap.get(yield* Ref.get(locals), address.lease)
			if (Option.isSome(local))
				yield* Deferred.succeed(local.value.lost, undefined)
		})
	const releaseResult = (
		address: Resource.Address,
		result: Resource.ReleaseResult,
	) =>
		result._tag === "Closed"
			? Effect.void
			: Effect.fail(
					Resource.Failed.make({
						resource: address,
						outcome: "unknown",
						failure: result.failure,
					}),
				)
	/** The physical owner signals release only after its scope has closed. */
	const releaseLocal = (address: Resource.Address) =>
		Effect.gen(function* () {
			const local = HashMap.get(yield* Ref.get(locals), address.lease)
			if (Option.isNone(local)) {
				const pending = HashMap.get(
					yield* Ref.get(pendingCloses),
					address.lease,
				)
				if (Option.isSome(pending)) return yield* pending.value
				const result = yield* directory.released(address)
				if (Option.isSome(result))
					return yield* releaseResult(address, result.value)
				return yield* failed(
					address,
					"unknown",
					Cause.fail("The resource owner has no close result."),
				)
			}
			yield* Deferred.succeed(local.value.lost, undefined)
			yield* local.value.released
		}).pipe(Effect.catchCause(safe(address, "unknown")))
	const closeAt = (address: Resource.Address) =>
		address.node === directory.node
			? closeLocal(address)
			: Effect.scoped(
					Effect.flatMap(client(address), (rpc) => rpc.Close({ address })),
				).pipe(
					Effect.timeout("5 seconds"),
					background.logFailure(
						"The old resource connection could not be closed.",
					),
				)
	const dispatch = (
		address: Resource.Address,
		input: Schema.Json,
	): Stream.Stream<Schema.Json, Resource.Error> =>
		Stream.unwrap(
			Effect.gen(function* () {
				if (!(yield* directory.current(address)))
					return yield* Resource.Gone.make({ resource: address })
				const found = HashMap.get(yield* Ref.get(locals), address.lease)
				if (Option.isNone(found))
					return yield* Resource.Gone.make({ resource: address })
				const local = found.value
				// The borrow lasts for the whole stream, including interruption and slow readers.
				yield* Effect.acquireRelease(
					Ref.modify(local.admission, (state) =>
						state.open
							? [true, { ...state, count: state.count + 1 }]
							: [false, state],
					).pipe(
						Effect.flatMap((open) =>
							open
								? Effect.void
								: Effect.fail(Resource.Gone.make({ resource: address })),
						),
					),
					() =>
						Ref.updateAndGet(local.admission, (state) => ({
							...state,
							count: state.count - 1,
						})).pipe(
							Effect.flatMap((state) =>
								!state.open && state.count === 0 ? local.close : Effect.void,
							),
						),
				)
				if (yield* Deferred.isDone(local.lost))
					return yield* Resource.Gone.make({ resource: address })
				// The feature reloads its saved call and rights here, on the node that sends.
				return local
					.handler(input)
					.pipe(
						Stream.interruptWhen(
							Deferred.await(local.lost).pipe(
								Effect.andThen(
									Effect.fail(ConnectionLost.make({ resource: address })),
								),
							),
						),
					)
			}),
		).pipe(
			Stream.catchCause((cause) =>
				Stream.fromEffect(safe(address, "unknown")(cause)),
			),
		)
	const exists = (address: Resource.Address) =>
		Effect.gen(function* () {
			const local = HashMap.get(yield* Ref.get(locals), address.lease)
			return (
				address.node === directory.node &&
				Option.isSome(local) &&
				(yield* Ref.get(local.value.admission)).open &&
				!(yield* Deferred.isDone(local.value.lost))
			)
		})
	const register = <E, AdmitE = never>(
		resource: Resource.Ref,
		handler: Handler<E>,
		options?: {
			readonly replace?: boolean
			readonly admit?: Effect.Effect<void, AdmitE>
			readonly release?: Effect.Effect<void, Resource.Error>
		},
		ownerReleased?: Effect.Effect<void, Resource.Error>,
	) =>
		Effect.gen(function* () {
			const previous = yield* directory.find(resource)
			if (Option.isSome(previous) && options?.replace !== true) {
				const address = previous.value
				const present =
					address.node === directory.node
						? yield* exists(address)
						: yield* Effect.scoped(
								Effect.flatMap(client(address), (rpc) =>
									rpc.Exists({ address }),
								),
							).pipe(
								Effect.timeout("5 seconds"),
								Effect.catchCause(safe(resource, "not_sent")),
							)
				// Only a reply from the physical owner can prove this healthy-node row is empty.
				if (!present) yield* directory.release(address)
			}
			const address = yield* directory.prepare(resource)
			const lost = yield* Deferred.make<void>()
			const released = yield* Deferred.make<void, Resource.Error>()
			const scope = yield* Scope.fork(yield* Scope.Scope)
			// Register before opening the physical resource in the caller's scope.
			// Its finalizers then finish before this registration leaves the directory.

			const admission = yield* Ref.make({ open: true, count: 0 })
			const close = Scope.close(scope, Exit.void)
			yield* Effect.acquireRelease(
				Ref.update(
					locals,
					HashMap.set(address.lease, {
						handler: (input) =>
							handler(input).pipe(
								Stream.catchCause((cause) =>
									Stream.fromEffect(safe(resource, "unknown")(cause)),
								),
							),
						lost,
						released: ownerReleased ?? Deferred.await(released),
						admission,
						close,
					}),
				),
				() =>
					Effect.gen(function* () {
						yield* Ref.update(admission, (state) => ({ ...state, open: false }))
						yield* Deferred.succeed(lost, undefined)
						if (ownerReleased === undefined) {
							const result = yield* closeResult(
								address,
								options?.release ?? Effect.void,
							).pipe(Effect.exit)
							yield* Deferred.done(released, result)
							if (Exit.isFailure(result))
								yield* Effect.failCause(result.cause).pipe(
									background.logFailure(
										"A resource close result could not be saved.",
									),
								)
						}
						yield* Ref.update(locals, HashMap.remove(address.lease))
						yield* directory
							.release(address)
							.pipe(
								background.logFailure(
									"A resource could not leave the directory.",
								),
							)
					}),
			).pipe(Scope.provide(scope))
			const held = yield* directory
				.claim(address, options?.replace === true, options?.admit)
				.pipe(
					Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
				)
			if (Option.isSome(held.previous)) yield* closeAt(held.previous.value)
			// One shared directory wake loop detects lost leases and database access.
			// Closing the physical owner does not replay an admitted call or audio frame.
			yield* directory.lost(address).pipe(
				Effect.onExit(() =>
					Ref.get(admission).pipe(
						Effect.flatMap((state) =>
							state.open ? Deferred.succeed(lost, undefined) : Effect.void,
						),
					),
				),
				background.logFailure("A resource lease could no longer be checked."),
				Effect.forkIn(scope),
			)
			// Retire blocks new calls. Existing calls may still give their final reply.
			const retire = Effect.uninterruptible(
				Effect.gen(function* () {
					const state = yield* Ref.updateAndGet(admission, (state) => ({
						...state,
						open: false,
					}))
					// Keep the admitted calls reachable by an explicit physical close.
					yield* directory
						.release(address)
						.pipe(Effect.ensuring(state.count === 0 ? close : Effect.void))
				}),
			)
			return { address, lost: Deferred.await(lost), retire }
		})
	/** Own acquisition, use, interruption, and the full close result in one scope. */
	const own = <A, E, R, HandlerE, AdmitE>(
		resource: Resource.Ref,
		handler: Handler<HandlerE>,
		options: {
			readonly admit: Effect.Effect<void, AdmitE>
			readonly replace?: boolean
		},
		use: (
			held: Effect.Success<ReturnType<typeof register>>,
		) => Effect.Effect<A, E, R>,
	) =>
		Effect.scoped(
			Effect.gen(function* () {
				const released = yield* Deferred.make<void, Resource.Error>()
				const held = yield* register(
					resource,
					handler,
					options,
					Deferred.await(released),
				)
				return yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const work = yield* restore(Effect.scoped(use(held))).pipe(
							Effect.forkScoped,
						)
						// Read the owner's full exit after interruption. A race alone drops a losing
						// fiber's close failure and would report a false release to another node.
						yield* restore(Effect.raceFirst(Fiber.await(work), held.lost)).pipe(
							Effect.ensuring(Fiber.interrupt(work)),
							Effect.exit,
						)
						const exit = yield* Fiber.await(work)
						const closed = yield* closeResult(
							held.address,
							Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
								? safe(resource, "unknown")(exit.cause)
								: Effect.void,
						).pipe(Effect.exit)
						yield* Deferred.done(released, closed)
						if (Exit.isFailure(closed))
							return yield* Effect.failCause(closed.cause)
						return yield* Exit.isFailure(exit)
							? Effect.failCause(exit.cause)
							: Effect.succeed(exit.value)
					}),
				)
			}),
		)
	const callAt = (
		address: Resource.Address,
		input: Schema.Json,
	): Stream.Stream<Schema.Json, Resource.Error> =>
		address.node === directory.node
			? dispatch(address, input)
			: Stream.unwrap(
					Effect.map(client(address), (rpc) => rpc.Call({ address, input })),
				).pipe(
					Stream.catchCause((cause) =>
						Stream.fromEffect(safe(address, "unknown")(cause)),
					),
				)
	const call = (
		resource: Resource.Ref,
		input: Schema.Json,
	): Stream.Stream<Schema.Json, Resource.Error> =>
		Stream.unwrap(
			Effect.gen(function* () {
				const address = yield* directory
					.find(resource)
					.pipe(Effect.catchCause(safe(resource, "not_sent")))
				if (Option.isNone(address))
					return yield* Resource.Gone.make({ resource })
				return callAt(address.value, input)
			}),
		)
	const close = (resource: Resource.Ref) =>
		Effect.flatMap(
			directory.find(resource),
			Option.match({
				onNone: () => Effect.void,
				onSome: closeAt,
			}),
		)
	const releaseAt = (address: Resource.Address) =>
		Effect.gen(function* () {
			const saved = yield* directory.released(address)
			if (Option.isSome(saved))
				return yield* releaseResult(address, saved.value)
			const close =
				address.node === directory.node
					? releaseLocal(address)
					: Effect.scoped(
							Effect.flatMap(client(address), (rpc) =>
								rpc.Release({ address }),
							),
						)
			yield* close.pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					(cause) =>
						directory
							.released(address)
							.pipe(
								Effect.flatMap((result) =>
									Option.isSome(result)
										? releaseResult(address, result.value)
										: safe(address, "unknown")(cause),
								),
							),
				),
			)
		}).pipe(Effect.catchCause(safe(address, "unknown")))
	const release = (
		resource: Pick<Resource.Ref, "namespace" | "kind"> & {
			readonly id?: string
		},
	) =>
		Effect.gen(function* () {
			// Runner health and missing routes do not prove that a physical close finished.
			const leases = yield* directory.leases(resource)
			yield* Effect.forEach(leases, releaseAt, {
				discard: true,
				concurrency: 16,
			})
		})

	return {
		register,
		own,
		call,
		callAt,
		dispatch,
		closeLocal,
		releaseLocal,
		releaseAt,
		exists,
		close,
		release,
	}
})

/** Physical resources share routing, authentication, bounds and failure semantics. */
export class Transport extends Context.Service<
	Transport,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/resources/Transport") {}
export const layer = Layer.effect(Transport, make).pipe(
	Layer.provide(PrivateRpc.layerClient),
	Layer.provide(RpcSerialization.layerNdjson),
)

export const layerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter
		const transport = yield* Transport
		const gate = yield* PrivateRpc.make
		const handlers = yield* Protocol.toHandlers({
			Call: ({ address, input }) => transport.dispatch(address, input),
			Close: ({ address }) => transport.closeLocal(address),
			Release: ({ address }) => transport.releaseLocal(address),
			Exists: ({ address }) => transport.exists(address),
		})
		const rpc = yield* RpcServer.toHttpEffect(Protocol, {
			streamBufferSize: 16,
		}).pipe(Effect.provideContext(handlers))
		yield* router.add("POST", path, gate.protect(rpc))
	}),
).pipe(Layer.provide(RpcSerialization.layerNdjson))
