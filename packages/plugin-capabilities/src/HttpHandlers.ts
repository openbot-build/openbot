import { Identity } from "@openbot-build/domain/Identity"
import { OpenBotApi } from "@openbot-build/api"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "@openbot-build/server-execution/HttpErrors"
import * as Resolve from "@openbot-build/conversation-contract/capabilities/Resolve"

export const layer = HttpApiBuilder.group(OpenBotApi, "requests", (handlers) =>
	Effect.gen(function* () {
		const resolve = yield* Resolve.make
		const http = yield* HttpErrors.make
		return handlers
			.handle("listRequests", ({ query }) =>
				Effect.flatMap(Identity, (caller) =>
					resolve.list(caller, query.status).pipe(http),
				),
			)
			.handle("getRequest", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					resolve.view(caller, params.requestId).pipe(http),
				),
			)
			.handle("resolveRequest", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					resolve.resolveAsPerson(caller, params.requestId, payload).pipe(http),
				),
			)
	}),
)
