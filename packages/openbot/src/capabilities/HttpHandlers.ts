import { Identity, OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Requests } from "./Requests.ts"
import { resolveAsPerson, visible } from "./Resolve.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "requests", (handlers) =>
	Effect.gen(function* () {
		const requests = yield* Requests
		const services =
			yield* Effect.context<
				Effect.Services<ReturnType<typeof resolveAsPerson>>
			>()
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
						Effect.provideContext(services),
					),
				),
			)
			.handle("resolveRequest", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					resolveAsPerson(caller, params.requestId, payload).pipe(
						Effect.provideContext(services),
					),
				),
			)
	}),
)
