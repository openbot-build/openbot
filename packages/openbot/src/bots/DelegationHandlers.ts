import { DelegationsApi, Identity, OpenBotApi } from "@openbot-build/api"
import { Clock, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
import { Coordinator } from "./Coordinator.ts"
import { Delegations, view } from "./Delegations.ts"

const implementations = Effect.gen(function* () {
	const delegations = yield* Delegations
	const coordinator = yield* Coordinator
	/** A delegation of one of the Chats of the caller. Other work does not exist for them. */
	const own = (id: string) =>
		Effect.gen(function* () {
			const caller = yield* Identity
			const found = yield* delegations
				.find(caller.organizationId, id)
				.pipe(
					Failures.replace("A delegation could not be read.", () =>
						DelegationsApi.DelegationStorageUnavailable.make({}),
					),
				)
			if (Option.isNone(found) || found.value.userId !== caller.userId)
				return yield* DelegationsApi.DelegationNotFound.make({ delegation: id })
			return { caller, stored: found.value }
		})
	return {
		getDelegation: ({
			params,
		}: {
			readonly params: { readonly delegationId: string }
		}) =>
			own(params.delegationId).pipe(
				Effect.flatMap(({ stored }) =>
					Effect.map(Clock.currentTimeMillis, (now) => view(stored, now)),
				),
			),
		cancelDelegation: ({
			params,
		}: {
			readonly params: { readonly delegationId: string }
		}) =>
			Effect.gen(function* () {
				const { caller } = yield* own(params.delegationId)
				yield* coordinator
					.cancel(
						caller.organizationId,
						params.delegationId,
						"A person stopped the work.",
					)
					.pipe(
						Failures.replace("A delegation could not be stopped.", () =>
							DelegationsApi.DelegationStorageUnavailable.make({}),
						),
					)
				return view(
					(yield* own(params.delegationId)).stored,
					yield* Clock.currentTimeMillis,
				)
			}),
	}
})
export const layerPlatform = HttpApiBuilder.group(
	OpenBotApi,
	"delegations",
	(handlers) =>
		Effect.map(implementations, (routes) => handlers.handleAll(routes)),
)
