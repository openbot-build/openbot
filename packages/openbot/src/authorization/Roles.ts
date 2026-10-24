import {
	Authorization,
	type OrganizationApi,
	type Roles as RolesApi,
} from "@openbot-build/api"
import { Context, type Effect, type Option, Schema } from "effect"

export class RolesUnavailable extends Schema.TaggedError<RolesUnavailable>()(
	"RolesUnavailable",
	{},
) {}

/** The built-in roles in their API form. */
export const builtin: ReadonlyArray<RolesApi.Role> =
	Authorization.builtinRoles.map((role) => ({ ...role, builtin: true }))

/** The built-in roles of every organization, and its custom roles. */
export class Roles extends Context.Service<
	Roles,
	{
		readonly list: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<RolesApi.Role>, RolesUnavailable>
		readonly get: (
			organizationId: string,
			roleId: string,
		) => Effect.Effect<Option.Option<RolesApi.Role>, RolesUnavailable>
		readonly create: (
			organizationId: string,
			input: RolesApi.CreateRoleRequest,
		) => Effect.Effect<RolesApi.Role, RolesUnavailable>
		readonly update: (
			organizationId: string,
			roleId: string,
			patch: RolesApi.UpdateRoleRequest,
		) => Effect.Effect<
			RolesApi.Role,
			| OrganizationApi.RoleNotFound
			| OrganizationApi.RoleReadOnly
			| RolesUnavailable
		>
		/** The caller checks that nothing uses the role first. */
		readonly delete: (
			organizationId: string,
			roleId: string,
		) => Effect.Effect<
			void,
			| OrganizationApi.RoleNotFound
			| OrganizationApi.RoleReadOnly
			| RolesUnavailable
		>
	}
>()("@openbot-build/openbot/authorization/Roles") {}
