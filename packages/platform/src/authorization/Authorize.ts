import { type Caller, Identity, Permissions } from "@openbot-build/platform-api"
import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { Tokens } from "../auth/Tokens.ts"
import { Organization } from "../organization/Organization.ts"
import { allowed, memberPolicies, resourceKey } from "./Policy.ts"

/**
 * The policy sets of a caller. A request must pass every set.
 * A member has one set. A user token adds its own set, so it never does more than its member.
 */
export const policySets = (
	caller: Caller,
): Effect.Effect<
	ReadonlyArray<ReadonlyArray<Permissions.Policy>>,
	Permissions.AuthorizationUnavailable,
	Organization | Tokens
> =>
	Effect.gen(function* () {
		const organization = yield* Organization
		const tokens = yield* Tokens
		const member = yield* organization.member(
			caller.organizationId,
			caller.userId,
		)
		if (Option.isNone(member) || member.value.status !== "active") return []
		const own = memberPolicies(member.value)
		if (caller.kind === "member" || caller.tokenId === undefined) return [own]
		const token = yield* tokens.find(caller, caller.tokenId)
		return Option.match(token, {
			onNone: () => [],
			onSome: (token) => [own, token.policies],
		})
	}).pipe(Effect.mapError(() => Permissions.AuthorizationUnavailable.make({})))

export const layer = Layer.effect(
	Permissions.Authorize,
	Effect.gen(function* () {
		const services = yield* Effect.context<Organization | Tokens>()
		return (httpEffect, { endpoint, group }) =>
			Effect.gen(function* () {
				const requirements = Option.orElse(
					Context.getOption(endpoint.annotations, Permissions.Required),
					() =>
						Option.map(
							Context.getOption(group.annotations, Permissions.GroupRequired),
							(rules) => (endpoint.method === "GET" ? rules.read : rules.write),
						),
				)
				if (Option.isNone(requirements))
					return yield* Effect.die(
						new Error(
							`The endpoint ${group.identifier}.${endpoint.name} does not say which permissions it needs.`,
						),
					)
				if (requirements.value.length === 0) return yield* httpEffect
				const caller = yield* Identity
				const params = yield* HttpRouter.params
				const sets = yield* policySets(caller).pipe(
					Effect.provideContext(services),
				)
				const subject = {
					organizationId: caller.organizationId,
					userId: caller.userId,
				}
				for (const requirement of requirements.value) {
					const key = resourceKey({
						subject,
						kind: requirement.resource.kind,
						id: Option.fromNullishOr(
							requirement.resource.param === undefined
								? undefined
								: params[requirement.resource.param],
						),
					})
					const permission = requirement.permission
					if (!allowed({ sets, permission, key, subject }))
						return yield* Permissions.PermissionDenied.make({
							permission: requirement.permission,
							resource: key,
						})
				}
				return yield* httpEffect
			})
	}),
)
