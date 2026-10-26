import { Identity, OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Requests } from "./Requests.ts"
import * as Resolve from "./Resolve.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "requests", (handlers) =>
	Effect.gen(function* () {
		const requests = yield* Requests
		const resolve = yield* Resolve.make
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
					resolve
						.visible(caller, params.requestId)
						.pipe(Effect.map((stored) => stored.request)),
				),
			)
			.handle("resolveRequest", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					resolve.resolveAsPerson(caller, params.requestId, payload),
				),
			)
	}),
)
