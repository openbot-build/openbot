import { Identity } from "@openbot-build/domain/Identity"
import { FailureApi, OpenBotApi } from "@openbot-build/api"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "@openbot-build/server-execution/HttpErrors"
import { Unavailable } from "@openbot-build/server-execution/Workflows"
import * as Failures from "@openbot-build/server-kernel/Failures"
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
					).pipe(
						safe,
						// No loaded feature owns the execution. Nothing failed, so it keeps no error record.
						Failures.map(
							"The feature of this delegation is not loaded.",
							<E>(error: E | Unavailable) =>
								Schema.is(Unavailable)(error)
									? FailureApi.FeatureUnavailable.make({
											feature: error.feature,
										})
									: error,
						),
					),
				)
		}),
)
