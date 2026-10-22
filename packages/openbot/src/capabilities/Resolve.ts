// These functions take the caller first, like the HTTP handlers that call them. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { AgentsApi, type Caller, RequestsApi } from "@openbot-build/api"
import { Effect, Option } from "effect"
import { Signal, Signals } from "../agents/Signals.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { Requests } from "./Requests.ts"

/** A person sees the requests of their own work. */
export const visible = (
	caller: { readonly organizationId: string; readonly userId: string },
	id: string,
) =>
	Effect.flatMap(Requests, (requests) =>
		requests
			.find(caller.organizationId, id)
			.pipe(
				Effect.flatMap((found) =>
					Option.isSome(found) && found.value.chain.userId === caller.userId
						? Effect.succeed(found.value)
						: Effect.fail(RequestsApi.RequestNotFound.make({ request: id })),
				),
			),
	)

/**
 * A person decides a request of their own work, from the API or from a button in a Channel.
 * The caller must already have `requests.resolve` on the request.
 */
export const resolveAsPerson = (
	caller: Caller,
	id: string,
	payload: RequestsApi.ResolveRequest,
) =>
	Effect.gen(function* () {
		const requests = yield* Requests
		const signals = yield* Signals
		const audit = yield* AuditLog
		yield* visible(caller, id)
		const outcome = yield* requests.decide(caller.organizationId, id, {
			by: { _tag: "Person", userId: caller.userId },
			allow: payload.decision === "allow",
			expected: payload.expected,
			...(payload.scope === undefined ? {} : { scope: payload.scope }),
			...(payload.reason === undefined ? {} : { reason: payload.reason }),
			...(payload.rule === undefined ? {} : { rule: payload.rule }),
		})
		yield* audit
			.record({
				organizationId: caller.organizationId,
				action: "capability.decided",
				actor: caller,
				resource: id,
				details: {
					decision: payload.decision,
					...(payload.scope === undefined ? {} : { scope: payload.scope }),
				},
			})
			.pipe(Effect.mapError(() => AgentsApi.AgentStorageUnavailable.make({})))
		// The waiting work goes on at once.
		yield* signals.publish(
			Signal.RequestChanged({
				organizationId: caller.organizationId,
				request: id,
			}),
		)
		return outcome.stored.request
	})
