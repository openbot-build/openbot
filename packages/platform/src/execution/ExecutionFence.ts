import * as InstanceWork from "./InstanceWork.ts"
import { Context, Effect, Layer, Option, Redacted, Schema, Scope } from "effect"

export type Intent = "admit" | "continue" | "write" | "send"
export interface Lease {
	readonly accountId: string
	readonly backend: "e" | "openbot"
	readonly epoch: number
	readonly leaseId: string
	readonly intent: Intent
}
export const CurrentSessionOwner = Context.Reference<
	{ readonly namespace: string; readonly accountId: string } | undefined
>("platform/execution/CurrentSessionOwner", { defaultValue: () => undefined })
export const RequestEpoch = Context.Reference<
	{ readonly accountId: string; readonly epoch: number } | undefined
>("platform/execution/RequestEpoch", { defaultValue: () => undefined })
export const CurrentExecution = Context.Reference<Lease | undefined>(
	"platform/execution/CurrentExecution",
	{ defaultValue: () => undefined },
)
export class FenceUnavailable extends Schema.TaggedError<FenceUnavailable>()(
	"FenceUnavailable",
	{},
) {}
export interface Options {
	readonly origin: string
	readonly token: Redacted.Redacted<string>
	readonly backend: "e" | "openbot"
}
export class ExecutionFence extends Context.Service<
	ExecutionFence,
	{
		readonly admit: <A, E, R>(
			accountId: string,
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | FenceUnavailable, R>
		readonly admitScoped: <A, E, R>(
			accountId: string,
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | FenceUnavailable, R | Scope.Scope>
		readonly guard: <A, E, R>(
			accountId: string,
			intent: Exclude<Intent, "admit">,
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | FenceUnavailable, R>
		readonly guardScoped: <A, E, R>(
			accountId: string,
			intent: Exclude<Intent, "admit">,
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | FenceUnavailable, R | Scope.Scope>
		readonly active: (accountId: string) => Effect.Effect<number>
		readonly quiesce: Effect.Effect<void>
		readonly resume: Effect.Effect<void>
		readonly status: Effect.Effect<{
			readonly quiesced: boolean
			readonly activeLeases: number
		}>
	}
>()("@openbot-build/platform/execution/ExecutionFence") {}

export const layer = (options?: Options) =>
	Layer.effect(
		ExecutionFence,
		Effect.sync(() => {
			if (options === undefined)
				return ExecutionFence.of({
					admit: (_, effect) => effect,
					admitScoped: (_, effect) => effect,
					guard: (_, __, effect) => effect,
					guardScoped: (_, __, effect) => effect,
					active: () => Effect.succeed(0),
					quiesce: Effect.void,
					resume: Effect.void,
					status: Effect.succeed({ quiesced: false, activeLeases: 0 }),
				})
			const active = new Map<string, Lease>()
			let quiesced = false,
				admissions = 0
			const Result = Schema.Struct({
				allowed: Schema.Boolean,
				epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
				phase: Schema.String,
				leaseId: Schema.optional(Schema.NonEmptyString),
			})
			const call = (path: string, body: object) =>
				Effect.tryPromise({
					try: async (signal) => {
						const response = await fetch(
							new URL("/internal/execution/" + path, options.origin),
							{
								method: "POST",
								headers: {
									authorization: "Bearer " + Redacted.value(options.token),
									"content-type": "application/json",
								},
								body: JSON.stringify(body),
								redirect: "error",
								signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
							},
						)
						if (!response.ok) throw new Error("Execution authority unavailable")
						return response.json()
					},
					catch: () => FenceUnavailable.make({}),
				})
			const result = (path: string, body: object) =>
				call(path, body).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Result)),
					Effect.mapError(() => FenceUnavailable.make({})),
				)
			const acquire = (accountId: string, epoch: number, intent: Intent) =>
				Effect.gen(function* () {
					const reply = yield* result("acquire", {
						accountId,
						epoch,
						intent,
						backend: options.backend,
					})
					if (
						!reply.allowed ||
						reply.epoch !== epoch ||
						reply.leaseId === undefined
					)
						return yield* FenceUnavailable.make({})
					const lease: Lease = {
						accountId,
						epoch,
						intent,
						backend: options.backend,
						leaseId: reply.leaseId,
					}
					active.set(lease.leaseId, lease)
					return lease
				})
			const release = (lease: Lease) =>
				call("release", lease).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							active.delete(lease.leaseId)
						}),
					),
					Effect.catch(() =>
						Effect.logError(
							"Execution lease release failed; migration remains blocked",
						),
					),
				)
			const withLease = <A, E, R>(
				lease: Effect.Effect<Lease, FenceUnavailable>,
				effect: Effect.Effect<A, E, R>,
			) =>
				Effect.acquireUseRelease(
					lease,
					(lease) => Effect.provideService(effect, CurrentExecution, lease),
					release,
				)
			const admission = (accountId: string) =>
				Effect.acquireUseRelease(
					Effect.gen(function* () {
						if (quiesced && !(yield* InstanceWork.admitted))
							return yield* FenceUnavailable.make({})
						admissions++
					}),
					() =>
						Effect.gen(function* () {
							const route = yield* result("resolve", {
								accountId,
								backend: options.backend,
							})
							const expectedEpoch = yield* RequestEpoch
							if (
								!route.allowed ||
								(expectedEpoch !== undefined &&
									expectedEpoch.accountId === accountId &&
									expectedEpoch.epoch !== route.epoch)
							)
								return yield* FenceUnavailable.make({})
							return yield* acquire(accountId, route.epoch, "admit")
						}),
					() =>
						Effect.sync(() => {
							admissions--
						}),
				)
			return ExecutionFence.of({
				quiesce: Effect.sync(() => {
					quiesced = true
				}),
				resume: Effect.sync(() => {
					quiesced = false
				}),
				status: Effect.sync(() => ({
					quiesced,
					activeLeases: active.size + admissions,
				})),
				admit: (accountId, effect) => withLease(admission(accountId), effect),
				admitScoped: (accountId, effect) =>
					Effect.gen(function* () {
						const lease = yield* Effect.acquireRelease(
							admission(accountId),
							release,
						)
						return yield* Effect.provideService(effect, CurrentExecution, lease)
					}),
				guard: (accountId, intent, effect) =>
					withLease(
						Effect.gen(function* () {
							const current = yield* CurrentExecution
							if (
								current === undefined ||
								current.accountId !== accountId ||
								current.backend !== options.backend
							)
								return yield* FenceUnavailable.make({})
							return yield* acquire(accountId, current.epoch, intent)
						}),
						intent === "write" ? Effect.uninterruptible(effect) : effect,
					),
				guardScoped: (accountId, intent, effect) =>
					Effect.gen(function* () {
						const current = yield* CurrentExecution
						if (
							current === undefined ||
							current.accountId !== accountId ||
							current.backend !== options.backend
						)
							return yield* FenceUnavailable.make({})
						const lease = yield* Effect.acquireRelease(
							acquire(accountId, current.epoch, intent),
							release,
						)
						return yield* Effect.provideService(effect, CurrentExecution, lease)
					}),
				active: (accountId) =>
					Effect.sync(
						() =>
							[...active.values()].filter(
								(lease) => lease.accountId === accountId,
							).length,
					),
			})
		}),
	)

/** Optional only for isolated hosts and tests; deployed servers install an explicit layer. */
// Account and intent precede the guarded Effect at call sites.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const guard = <A, E, R>(
	accountId: string,
	intent: Exclude<Intent, "admit">,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FenceUnavailable, R> =>
	Effect.flatMap(Effect.serviceOption(ExecutionFence), (fence) =>
		Option.isSome(fence)
			? fence.value.guard(accountId, intent, effect)
			: effect,
	)
// @effect-diagnostics-next-line missingPipeableSignature:off
export const admit = <A, E, R>(
	accountId: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FenceUnavailable, R> =>
	Effect.flatMap(Effect.serviceOption(ExecutionFence), (fence) =>
		Option.isSome(fence) ? fence.value.admit(accountId, effect) : effect,
	)

// @effect-diagnostics-next-line missingPipeableSignature:off
export const guardScoped = <A, E, R>(
	accountId: string,
	intent: Exclude<Intent, "admit">,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FenceUnavailable, R | Scope.Scope> =>
	Effect.flatMap(Effect.serviceOption(ExecutionFence), (fence) =>
		Option.isSome(fence)
			? fence.value.guardScoped(accountId, intent, effect)
			: effect,
	)

// @effect-diagnostics-next-line missingPipeableSignature:off
export const admitScoped = <A, E, R>(
	accountId: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FenceUnavailable, R | Scope.Scope> =>
	Effect.flatMap(Effect.serviceOption(ExecutionFence), (fence) =>
		Option.isSome(fence) ? fence.value.admitScoped(accountId, effect) : effect,
	)
