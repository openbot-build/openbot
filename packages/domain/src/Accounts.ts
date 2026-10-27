import { Schema } from "effect"
import { RoleId } from "./Roles.ts"

/** One organization of the signed-in account. */
export const Membership = Schema.Struct({
	organizationId: Schema.String,
	name: Schema.String,
	status: Schema.Literals(["active", "suspended"]),
	roles: Schema.Array(RoleId),
})
export type Membership = typeof Membership.Type
export const SessionInfo = Schema.Struct({
	userId: Schema.String,
	profile: Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		email: Schema.optionalKey(Schema.String),
		emailVerified: Schema.optionalKey(Schema.Boolean),
	}),
	/** The organizations of the account. Each action names the organization where it acts. */
	memberships: Schema.Array(Membership),
	/** Whether the account may manage the platform. */
	platformAdmin: Schema.Boolean,
	expiresAt: Schema.String,
})
