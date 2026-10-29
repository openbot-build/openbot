import { Array as Arr, Record as Rec, Schema } from "effect"
import { Caller } from "./Identity.ts"
import {
	InvitationId,
	InvitationInvalid,
	InvitationNotFound,
	InvitationStatus,
} from "./Invitation.ts"
import { Email } from "./Email.ts"
import { Delivery } from "./Mail.ts"
import { PolicyInput, PolicySchema } from "./Authorization.ts"
import { RoleId } from "./Roles.ts"

/** A member always has at least one role. */
export const Roles = Schema.Array(RoleId).check(Schema.isMinLength(1))

export const OrganizationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
export const OrganizationStatus = Schema.Literals(["active", "suspended"])
export const Organization = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** A platform admin can suspend an organization. Then nobody can use it. */
	status: OrganizationStatus,
	createdAt: Schema.String,
})
export type Organization = typeof Organization.Type
export const UpdateOrganizationRequest = Schema.Struct({
	name: Schema.optionalKey(OrganizationName),
})
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type
export const CreateOrganizationRequest = Schema.Struct({
	name: OrganizationName,
})
export type CreateOrganizationRequest = typeof CreateOrganizationRequest.Type

export const MemberStatus = Schema.Literals(["active", "suspended"])
export const Member = Schema.Struct({
	userId: Schema.String,
	email: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	status: MemberStatus,
	roles: Schema.Array(RoleId),
	manualRoles: Schema.optionalKey(Schema.Array(RoleId)),
	roleSources: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ providerId: Schema.String, role: Schema.String }),
		),
	),
	/** An extra policy for this member, on top of the policies of the roles. */
	policy: PolicySchema,
	joinedAt: Schema.String,
})
export type Member = typeof Member.Type
export const UpdateMemberRequest = Schema.Struct({
	status: Schema.optionalKey(MemberStatus),
	roles: Schema.optionalKey(Schema.Array(RoleId)),
	policy: Schema.optionalKey(PolicyInput),
})
export type UpdateMemberRequest = typeof UpdateMemberRequest.Type

export { InvitationId, InvitationInvalid, InvitationNotFound, InvitationStatus }
/**
 * An invitation to join an organization, or to use one shared Bot of it.
 * The person with this verified email can accept it.
 */
export const Invitation = Schema.Struct({
	id: InvitationId,
	organizationId: Schema.String,
	organizationName: Schema.String,
	email: Schema.String,
	/** The roles that the person gets when they accept. An invitation to a Bot has none. */
	roles: Schema.Array(RoleId),
	status: InvitationStatus,
	/** The user ID of the person who made the invitation. */
	invitedBy: Schema.String,
	createdAt: Schema.String,
	expiresAt: Schema.String,
	/**
	 * Only for an invitation to use one Bot. Accept it with
	 * `POST /v1/bot-invitations/accept`. `roles` is empty then.
	 */
	bot: Schema.optionalKey(
		Schema.Struct({ id: Schema.String, name: Schema.String }),
	),
})
export type Invitation = typeof Invitation.Type
/** Creating the invitation succeeds even if its mail could not be sent. */
export const CreateInvitationResponse = Schema.Struct({
	...Invitation.fields,
	delivery: Schema.optionalKey(Delivery),
})
export type CreateInvitationResponse = typeof CreateInvitationResponse.Type
export const CreateInvitationRequest = Schema.Struct({
	email: Email,
	/** Without it, the person gets the default roles of the organization. */
	roles: Schema.optionalKey(Roles),
})
export type CreateInvitationRequest = typeof CreateInvitationRequest.Type

/**
 * The audit actions of each resource. Each action id joins the resource and
 * the action with a dot, such as `token.created`.
 */
const auditActionTree = {
	member: ["joined", "updated", "removed", "left"],
	invitation: ["created", "revoked", "accepted", "declined", "send_requested"],
	bot_member: ["joined", "removed"],
	organization: ["created", "updated"],
	settings: ["updated"],
	role: ["created", "updated", "deleted"],
	model: ["created", "updated", "deleted"],
	model_provider: ["created", "updated", "deleted"],
	domain: ["added", "verified", "removed"],
	sso_connection: ["created", "updated", "deleted"],
	token: ["created", "revoked"],
	bot: [
		"created",
		"updated",
		"promoted",
		"memory.updated",
		"memory.purged",
		"memory_bot.updated",
	],
	delegation: ["started", "completed"],
	capability: ["decided"],
	request: ["resolved"],
	grant: ["created", "revoked"],
	rule: ["created", "updated"],
	trigger: ["created", "updated", "deleted", "hook_changed", "fired"],
	channel: ["created", "updated", "deleted", "secret_changed"],
	channel_identity: ["linked", "unlinked"],
	computer_provider: ["created", "updated", "deleted"],
	computer: [
		"created",
		"updated",
		"deleted",
		"paired",
		"token_changed",
		"granted",
		"revoked",
		"port_opened",
	],
	secret_provider: ["created", "updated", "deleted"],
	vault: [
		"created",
		"updated",
		"deleted",
		"item.created",
		"item.updated",
		"item.deleted",
		"granted",
		"revoked",
	],
	model_price: ["set"],
	budget: ["created", "updated", "deleted"],
	credits: ["updated", "granted"],
} as const satisfies Record<string, ReadonlyArray<string>>
type AuditActionTree = typeof auditActionTree
/** The audit actions of one resource, such as `token.created`. */
export type AuditActionOf<Resource extends keyof AuditActionTree> =
	`${Resource}.${AuditActionTree[Resource][number]}`

export const AuditAction = Schema.Literals(
	Arr.flatMap(Rec.toEntries(auditActionTree), ([resource, actions]) =>
		Arr.map(actions, (action) => `${resource}.${action}` as const),
	),
)
export type AuditAction = typeof AuditAction.Type
export const AuditLogEntry = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.String,
	action: AuditAction,
	actor: Caller,
	resource: Schema.String,
	details: Schema.JsonObject,
})
export type AuditLogEntry = typeof AuditLogEntry.Type

export class MemberNotFound extends Schema.TaggedError<
	MemberNotFound,
	{ readonly brand: unique symbol }
>()("MemberNotFound", { userId: Schema.String }) {}
/** An organization must keep at least one active Super Administrator. */
export class LastSuperAdministrator extends Schema.TaggedError<
	LastSuperAdministrator,
	{ readonly brand: unique symbol }
>()("LastSuperAdministrator", {}) {}
export class RoleNotFound extends Schema.TaggedError<
	RoleNotFound,
	{ readonly brand: unique symbol }
>()("RoleNotFound", { roleId: RoleId }) {}
/** Members or the settings still use the role. Give them another role first. */
export class RoleInUse extends Schema.TaggedError<
	RoleInUse,
	{ readonly brand: unique symbol }
>()("RoleInUse", {
	roleId: RoleId,
}) {}
/** Built-in roles cannot change. */
export class RoleReadOnly extends Schema.TaggedError<
	RoleReadOnly,
	{ readonly brand: unique symbol }
>()("RoleReadOnly", { roleId: RoleId }) {}
/** Only platform admins can create organizations on this platform. */
export class OrganizationCreationDisabled extends Schema.TaggedError<
	OrganizationCreationDisabled,
	{ readonly brand: unique symbol }
>()("OrganizationCreationDisabled", {}) {}
export class OrganizationStorageUnavailable extends Schema.TaggedError<
	OrganizationStorageUnavailable,
	{ readonly brand: unique symbol }
>()("OrganizationStorageUnavailable", {}) {}
