import { Array as Arr, Schema } from "effect"
import { builtinRoles, PolicyInput, PolicySchema } from "./Authorization.ts"

export const BuiltinRoleId = Schema.Literals(
	Arr.map(builtinRoles, (role) => role.id),
)
export type BuiltinRoleId = typeof BuiltinRoleId.Type
/** The ID of a custom role. */
export const CustomRoleId = Schema.String.check(
	Schema.isPattern(/^role_[a-z0-9]{32}$/),
).pipe(Schema.brand("@openbot-build/api/CustomRoleId"))
export type CustomRoleId = typeof CustomRoleId.Type
export const RoleId = Schema.Union([BuiltinRoleId, CustomRoleId])
export type RoleId = typeof RoleId.Type
export const isBuiltinRole = Schema.is(BuiltinRoleId)

export const RoleName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
/** A role gives its policy to every member with the role. */
export const Role = Schema.Struct({
	id: RoleId,
	name: Schema.String,
	description: Schema.String,
	builtin: Schema.Boolean,
	policy: PolicySchema,
})
export type Role = typeof Role.Type
export const CreateRoleRequest = Schema.Struct({
	name: RoleName,
	description: Schema.String.check(Schema.isMaxLength(1000)),
	policy: PolicyInput,
})
export type CreateRoleRequest = typeof CreateRoleRequest.Type
export const UpdateRoleRequest = Schema.Struct({
	name: Schema.optionalKey(RoleName),
	description: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(1000)),
	),
	policy: Schema.optionalKey(PolicyInput),
})
export type UpdateRoleRequest = typeof UpdateRoleRequest.Type
