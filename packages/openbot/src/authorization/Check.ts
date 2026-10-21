import { type Caller, Permissions } from "@openbot-build/api"
import { Effect } from "effect"
import { policySets, type Services } from "./Authorize.ts"
import { allowed } from "./Policy.ts"

/**
 * Checks one permission on one resource key for a caller, in a handler or in a capability check.
 * Use it when the key depends on data that the path does not show.
 */
export const can = (input: {
	readonly caller: Caller
	readonly permission: Permissions.PermissionGroupId
	readonly key: string
}): Effect.Effect<boolean, Permissions.AuthorizationUnavailable, Services> =>
	policySets(input.caller).pipe(
		Effect.map(({ sets, ceiling }) =>
			allowed({
				sets,
				ceiling,
				permission: input.permission,
				key: input.key,
				subject: {
					organizationId: input.caller.organizationId,
					userId: input.caller.userId,
				},
			}),
		),
	)
