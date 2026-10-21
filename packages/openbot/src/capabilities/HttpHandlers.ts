import {
	AgentsApi,
	Identity,
	OpenBotApi,
	RequestsApi,
} from "@openbot-build/api"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Signal, Signals } from "../agents/Signals.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { Requests } from "./Requests.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "requests", (handlers) =>
	Effect.gen(function* () {
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
		return handlers
			.handle("listRequests", ({ query }) =>
				Effect.flatMap(Identity, (caller) =>
					requests.forPerson(
						caller.organizationId,
						caller.userId,
						query.status,
					),
				),
			)
			.handle("getRequest", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					visible(caller, params.requestId).pipe(
						Effect.map((stored) => stored.request),
					),
				),
			)
			.handle("resolveRequest", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					yield* visible(caller, params.requestId)
					const outcome = yield* requests.decide(
						caller.organizationId,
						params.requestId,
						{
							by: { _tag: "Person", userId: caller.userId },
							allow: payload.decision === "allow",
							expected: payload.expected,
							...(payload.scope === undefined ? {} : { scope: payload.scope }),
							...(payload.reason === undefined
								? {}
								: { reason: payload.reason }),
							...(payload.rule === undefined ? {} : { rule: payload.rule }),
						},
					)
					yield* audit
						.record({
							organizationId: caller.organizationId,
							action: "capability.decided",
							actor: caller,
							resource: params.requestId,
							details: {
								decision: payload.decision,
								...(payload.scope === undefined
									? {}
									: { scope: payload.scope }),
							},
						})
						.pipe(
							Effect.mapError(() => AgentsApi.AgentStorageUnavailable.make({})),
						)
					// The waiting work goes on at once.
					yield* signals.publish(
						Signal.RequestChanged({
							organizationId: caller.organizationId,
							request: params.requestId,
						}),
					)
					return outcome.stored.request
				}),
			)
	}),
)
