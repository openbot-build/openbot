import * as InstanceWork from "../execution/InstanceWork.ts"
import { createHmac } from "node:crypto"
import {
	Context,
	Effect,
	HashSet,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
} from "effect"
import { AuthUnavailable } from "./Model.ts"
import type { Options } from "../execution/ExecutionFence.ts"

export const Profile = Schema.Struct({
	issuer: Schema.String,
	clientId: Schema.String,
	providerId: Schema.String,
	publicOrigin: Schema.String,
	redirectUri: Schema.String,
	sessionCookie: Schema.String,
	loginCookie: Schema.String,
	basePath: Schema.Literal("/auth"),
	sdkVersion: Schema.Literal("1.7.8"),
})
export type Profile = typeof Profile.Type
interface Registration {
	readonly profile: Profile
	readonly secret: Redacted.Redacted<string>
	readonly readSession: (headers: Headers) => Effect.Effect<
		{
			readonly accountId: string | null
			readonly setCookies: ReadonlyArray<string>
		},
		AuthUnavailable
	>
	readonly revocationStatus: (input: {
		readonly accountId: string
		readonly credentialDigest: string
		readonly retry: boolean
		readonly key: Redacted.Redacted<string>
	}) => Effect.Effect<boolean, AuthUnavailable>
	readonly revokeSession: (input: {
		readonly headers: Headers
		readonly accountId: string
		readonly credentialDigest: string
		readonly key: Redacted.Redacted<string>
	}) => Effect.Effect<ReadonlyArray<string>, AuthUnavailable>
}
export class Barrier extends Context.Service<
	Barrier,
	{
		readonly register: (input: Registration) => Effect.Effect<void>
		readonly readSession: Registration["readSession"]
		readonly revokeSession: (input: {
			readonly headers: Headers
			readonly accountId: string
			readonly credentialDigest: string
		}) => Effect.Effect<ReadonlyArray<string>, AuthUnavailable>
		readonly revocationStatus: (input: {
			readonly accountId: string
			readonly credentialDigest: string
			readonly retry: boolean
		}) => Effect.Effect<boolean, AuthUnavailable>
		readonly wrap: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | AuthUnavailable, R>
		readonly active: Effect.Effect<number>
		readonly attest: (
			challenge: string,
		) => Effect.Effect<
			{ readonly profile: Profile; readonly proof: string },
			AuthUnavailable
		>
	}
>()("@openbot-build/openbot/auth/Barrier") {}
export const CurrentAuthLease = Context.Reference<boolean>(
	"platform/auth/CurrentAuthLease",
	{ defaultValue: () => false },
)
const unavailable = () => AuthUnavailable.make({ dependency: "storage" })
export const layer = (options?: Options) =>
	Layer.effect(
		Barrier,
		Effect.gen(function* () {
			const active = yield* Ref.make(HashSet.empty<string>())
			const configured = yield* Ref.make<Option.Option<Registration>>(
				Option.none(),
			)
			const call = (path: string, body: object) =>
				options === undefined
					? Effect.fail(unavailable())
					: Effect.tryPromise({
							try: async (signal) => {
								const response = await fetch(
									new URL("/internal/auth/" + path, options.origin),
									{
										method: "POST",
										headers: {
											authorization: "Bearer " + Redacted.value(options.token),
											"content-type": "application/json",
										},
										body: JSON.stringify(body),
										signal: AbortSignal.any([
											signal,
											AbortSignal.timeout(10000),
										]),
										redirect: "error",
									},
								)
								if (!response.ok)
									throw new Error("Authentication authority unavailable")
								return response.json()
							},
							catch: unavailable,
						})
			const Lease = Schema.Struct({
				allowed: Schema.Boolean,
				epoch: Schema.Natural,
				phase: Schema.String,
				leaseId: Schema.optionalKey(Schema.String),
			})
			const acquire = Effect.gen(function* () {
				if (options === undefined) return yield* unavailable()
				const lease = yield* call("admit", { backend: options.backend }).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Lease)),
					Effect.mapError(unavailable),
				)
				if (!lease.allowed || lease.leaseId === undefined)
					return yield* unavailable()
				yield* Ref.update(active, HashSet.add(lease.leaseId))
				return {
					backend: options.backend,
					epoch: lease.epoch,
					leaseId: lease.leaseId,
				}
			})
			const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				InstanceWork.wrap(Effect.uninterruptible(effect)).pipe(
					Effect.catchTag("InstancePaused", unavailable),
				)
			return Barrier.of({
				register: (input) => Ref.set(configured, Option.some(input)),
				readSession: (headers) =>
					Effect.flatMap(Ref.get(configured), (value) =>
						Option.isNone(value)
							? Effect.fail(unavailable())
							: value.value.readSession(headers),
					),
				revocationStatus: (input) =>
					tracked(
						Effect.flatMap(Ref.get(configured), (value) =>
							Option.isNone(value) || options === undefined
								? Effect.fail(unavailable())
								: value.value.revocationStatus({
										...input,
										key: options.token,
									}),
						),
					),
				revokeSession: (input) =>
					tracked(
						Effect.flatMap(Ref.get(configured), (value) =>
							Option.isNone(value) || options === undefined
								? Effect.fail(unavailable())
								: value.value.revokeSession({ ...input, key: options.token }),
						),
					),
				// A cancelled HTTP request must not release its lease while an SDK database write is still running.

				wrap: (effect) =>
					tracked(
						options === undefined
							? effect
							: Effect.flatMap(CurrentAuthLease, (held) =>
									held
										? effect
										: Effect.acquireUseRelease(
												acquire,
												() =>
													Effect.provideService(
														Effect.uninterruptible(effect),
														CurrentAuthLease,
														true,
													),
												(lease) =>
													call("release", lease).pipe(
														Effect.andThen(
															Ref.update(active, HashSet.remove(lease.leaseId)),
														),
														Effect.catch(() =>
															Effect.logError(
																"Authentication lease release failed; identity migration remains blocked.",
															),
														),
													),
											),
								),
					),
				active: Ref.get(active).pipe(Effect.map(HashSet.size)),
				attest: (challenge) =>
					Effect.gen(function* () {
						const value = yield* Ref.get(configured)
						if (Option.isNone(value)) return yield* unavailable()
						return {
							profile: value.value.profile,
							proof: createHmac("sha256", Redacted.value(value.value.secret))
								.update(challenge)
								.digest("hex"),
						}
					}),
			})
		}),
	)

/** Shared identity and configuration writes participate in the same migration and instance gates. */
export const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.flatMap(Effect.serviceOption(Barrier), (barrier) =>
		Option.isSome(barrier)
			? barrier.value.wrap(effect)
			: InstanceWork.wrap(Effect.uninterruptible(effect)).pipe(
					Effect.catchTag("InstancePaused", () =>
						AuthUnavailable.make({ dependency: "storage" }),
					),
				),
	)
