import { type OrganizationApi, Permissions } from "@openbot-build/api"
import { Context, type Effect, type Option, Schema } from "effect"

export class RolesUnavailable extends Schema.TaggedError<RolesUnavailable>()(
	"RolesUnavailable",
	{},
) {}

/** The built-in roles in their API form. */
export const builtin: ReadonlyArray<Permissions.Role> =
	Permissions.builtinRoles.map((role) => ({ ...role, builtin: true }))

/** The built-in roles of every organization, and its custom roles. */
export class Roles extends Context.Service<
	Roles,
	{
		readonly list: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<Permissions.Role>, RolesUnavailable>
		readonly get: (
			organizationId: string,
			roleId: string,
		) => Effect.Effect<Option.Option<Permissions.Role>, RolesUnavailable>
		readonly create: (
			organizationId: string,
			input: Permissions.CreateRoleRequest,
		) => Effect.Effect<Permissions.Role, RolesUnavailable>
		readonly update: (
			organizationId: string,
			roleId: string,
			patch: Permissions.UpdateRoleRequest,
		) => Effect.Effect<
			Permissions.Role,
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
