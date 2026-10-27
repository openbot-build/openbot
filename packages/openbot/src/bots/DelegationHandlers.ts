import { OpenBotApi } from "@openbot-build/api"
import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "../execution/HttpErrors.ts"
import * as DelegationQueries from "./DelegationQueries.ts"

export const layerPlatform = HttpApiBuilder.group(
	OpenBotApi,
	"delegations",
	(handlers) =>
		Effect.gen(function* () {
			const queries = yield* DelegationQueries.make
			const safe = yield* HttpErrors.make
			return handlers
				.handle("getDelegation", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						queries.read(caller, params.delegationId),
					).pipe(safe),
				)
				.handle("cancelDelegation", ({ params, payload }) =>
					Effect.flatMap(Identity, (caller) =>
						queries.cancel(caller, params.delegationId, payload.commandKey),
					).pipe(safe),
				)
		}),
)
