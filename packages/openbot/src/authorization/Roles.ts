import {
	type Organizations as OrganizationsModel,
	type Roles as RolesModel,
} from "@openbot-build/domain"

import { Authorization } from "@openbot-build/domain"
import { Array as Arr, Context, type Effect, type Option, Schema } from "effect"

/** OpenBot cannot read or write the roles now. */
export class RolesUnavailable extends Schema.TaggedError<
	RolesUnavailable,
	{ readonly brand: unique symbol }
>()("RolesUnavailable", { cause: Schema.Defect() }) {}

/** The built-in roles in their API form. */
export const builtin: ReadonlyArray<RolesModel.Role> = Arr.map(
	Authorization.builtinRoles,
	(role) => ({ ...role, builtin: true }),
)

/** The built-in roles of every organization, and its custom roles. */
export class Roles extends Context.Service<
	Roles,
	{
		readonly list: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<RolesModel.Role>, RolesUnavailable>
		readonly get: (
			organizationId: string,
			roleId: RolesModel.RoleId,
		) => Effect.Effect<Option.Option<RolesModel.Role>, RolesUnavailable>
		readonly create: (
			organizationId: string,
			input: RolesModel.CreateRoleRequest,
		) => Effect.Effect<RolesModel.Role, RolesUnavailable>
		readonly update: (
			organizationId: string,
			roleId: RolesModel.RoleId,
			patch: RolesModel.UpdateRoleRequest,
		) => Effect.Effect<
			RolesModel.Role,
			| OrganizationsModel.RoleNotFound
			| OrganizationsModel.RoleReadOnly
			| RolesUnavailable
		>
		/** The caller checks that nothing uses the role first. */
		readonly delete: (
			organizationId: string,
			roleId: RolesModel.RoleId,
		) => Effect.Effect<
			void,
			| OrganizationsModel.RoleNotFound
			| OrganizationsModel.RoleReadOnly
			| RolesUnavailable
		>
	}
>()("@openbot-build/openbot/authorization/Roles") {}
