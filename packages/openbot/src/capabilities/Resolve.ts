import { BotsApi, type Caller, RequestsApi } from "@openbot-build/api"
import { Effect, Option } from "effect"
import * as Failures from "../app/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { Signal, Signals } from "../bots/Signals.ts"
import { Requests } from "./Requests.ts"

/**
 * Takes the services once, and gives the functions that let a person read and
 * decide the requests of their own work. Their effects need no services.
 */
export const make = Effect.gen(function* () {
	const requests = yield* Requests
	const signals = yield* Signals
	const audit = yield* AuditLog
	/** A person sees the requests of their own work. */
	const visible = (
		caller: { readonly organizationId: string; readonly userId: string },
		id: string,
	) =>
		requests
			.find(caller.organizationId, id)
			.pipe(
				Effect.flatMap((found) =>
					Option.isSome(found) && found.value.chain.userId === caller.userId
						? Effect.succeed(found.value)
						: Effect.fail(RequestsApi.RequestNotFound.make({ request: id })),
				),
			)
	/**
	 * A person decides a request of their own work, from the API or from a button in a Channel.
	 * The caller must already have `requests.resolve` on the request.
	 */
	const resolveAsPerson = (
		caller: Caller,
		id: string,
		payload: RequestsApi.ResolveRequest,
	) =>
		Effect.gen(function* () {
			yield* visible(caller, id)
			// The waiting work must hear of a saved decision, and the audit log must keep it,
			// even when the client goes away. So the signal and the audit entry go out
			// together with the decision. The signal goes first, so an audit failure cannot
			// stop it.
			const outcome = yield* requests
				.decide(caller.organizationId, id, {
					by: { _tag: "Person", userId: caller.userId },
					allow: payload.decision === "allow",
					expected: payload.expected,
					...(payload.scope === undefined ? {} : { scope: payload.scope }),
					...(payload.reason === undefined ? {} : { reason: payload.reason }),
					...(payload.rule === undefined ? {} : { rule: payload.rule }),
				})
				.pipe(
					Effect.tap(() =>
						signals.publish(
							Signal.RequestChanged({
								organizationId: caller.organizationId,
								request: id,
							}),
						),
					),
					Effect.tap(() =>
						audit
							.record({
								organizationId: caller.organizationId,
								action: "capability.decided",
								actor: caller,
								resource: id,
								details: {
									decision: payload.decision,
									...(payload.scope === undefined
										? {}
										: { scope: payload.scope }),
								},
							})
							.pipe(
								Failures.replace(
									"OpenBot could not write the decision to the audit log.",
									() => BotsApi.BotStorageUnavailable.make({}),
								),
							),
					),
					Effect.uninterruptible,
				)
			return outcome.stored.request
		})
	return { visible, resolveAsPerson }
})
