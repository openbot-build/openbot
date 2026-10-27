import { Schema } from "effect"
import { Email } from "./Email.ts"
import { OrganizationStatus } from "./Organizations.ts"

export const PlatformAdmin = Schema.Struct({
	/** A person becomes a platform admin when they sign in with this verified email. */
	email: Schema.String,
	/** Null until the person signs in for the first time. */
	userId: Schema.NullOr(Schema.String),
	addedAt: Schema.String,
})
export type PlatformAdmin = typeof PlatformAdmin.Type
export const AddPlatformAdminRequest = Schema.Struct({
	email: Email,
})
export const UpdatePlatformOrganizationRequest = Schema.Struct({
	status: OrganizationStatus,
})

export class PlatformAdminNotFound extends Schema.TaggedError<
	PlatformAdminNotFound,
	{ readonly brand: unique symbol }
>()("PlatformAdminNotFound", { email: Schema.String }) {}
/** The platform must keep at least one admin. */
export class LastPlatformAdmin extends Schema.TaggedError<
	LastPlatformAdmin,
	{ readonly brand: unique symbol }
>()("LastPlatformAdmin", {}) {}
export class OrganizationNotFound extends Schema.TaggedError<
	OrganizationNotFound,
	{ readonly brand: unique symbol }
>()("OrganizationNotFound", { organizationId: Schema.String }) {}
export class PlatformUnavailable extends Schema.TaggedError<
	PlatformUnavailable,
	{ readonly brand: unique symbol }
>()("PlatformUnavailable", {}) {}
