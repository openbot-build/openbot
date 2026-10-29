import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AccountAuth, NoStore } from "./AuthApi.ts"
import { Limit } from "./Page.ts"
import { Delivery } from "./Mail.ts"
import {
	AuthorizationErrors,
	Required,
	ResourceInfo,
	organization,
} from "./Authorization.ts"
import { CreateRoleRequest, Role, RoleId, UpdateRoleRequest } from "./Roles.ts"
import {
	OrganizationSettings,
	SettingsErrors,
	UpdateOrganizationSettingsRequest,
} from "./Settings.ts"
import {
	InvitationId,
	InvitationStatus,
	InvitationNotFound,
	InvitationInvalid,
} from "@openbot-build/domain/Invitation"
export {
	InvitationId,
	InvitationInvalid,
	InvitationNotFound,
	InvitationStatus,
} from "@openbot-build/domain/Invitation"
import {
	Organization,
	UpdateOrganizationRequest,
	CreateOrganizationRequest,
	Member,
	UpdateMemberRequest,
	Invitation,
	CreateInvitationRequest,
	CreateInvitationResponse,
	AuditAction,
	AuditLogEntry,
	MemberNotFound,
	LastSuperAdministrator,
	RoleNotFound,
	RoleInUse,
	RoleReadOnly,
	OrganizationCreationDisabled,
	OrganizationStorageUnavailable,
} from "@openbot-build/domain/Organizations"
export {
	Roles,
	OrganizationName,
	OrganizationStatus,
	Organization,
	UpdateOrganizationRequest,
	CreateOrganizationRequest,
	MemberStatus,
	Member,
	UpdateMemberRequest,
	Invitation,
	CreateInvitationRequest,
	CreateInvitationResponse,
	type AuditActionOf,
	AuditAction,
	AuditLogEntry,
	MemberNotFound,
	LastSuperAdministrator,
	RoleNotFound,
	RoleInUse,
	RoleReadOnly,
	OrganizationCreationDisabled,
	OrganizationStorageUnavailable,
} from "@openbot-build/domain/Organizations"

const errors = [
	OrganizationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
/** Changing a member can also need Super Administrator rights, so these endpoints can deny on their own. */
const memberErrors = [
	...errors,
	...AuthorizationErrors,
	MemberNotFound.pipe(HttpApiSchema.status(404)),
	LastSuperAdministrator.pipe(HttpApiSchema.status(409)),
] as const

/** Inviting with a role can also need Super Administrator rights, so these endpoints can deny on their own. */
const invitationErrors = [
	...errors,
	...AuthorizationErrors,
	InvitationNotFound.pipe(HttpApiSchema.status(404)),
	InvitationInvalid.pipe(HttpApiSchema.status(400)),
	RoleNotFound.pipe(HttpApiSchema.status(404)),
] as const

const readMembers = [organization("read", "Member")]
const writeMembers = [organization("write", "Member")]
const writeRoles = [organization("write", "Role")]
/** A role cannot give more than the person who writes it has, so these endpoints can deny on their own. */
const roleErrors = [
	...errors,
	...AuthorizationErrors,
	RoleNotFound.pipe(HttpApiSchema.status(404)),
	RoleInUse.pipe(HttpApiSchema.status(409)),
	RoleReadOnly.pipe(HttpApiSchema.status(409)),
] as const

export class OrganizationApi extends HttpApiGroup.make("organization").add(
	HttpApiEndpoint.get("getOrganization", "/v1/organization", {
		success: Organization,
		error: errors,
	}),
	HttpApiEndpoint.patch("updateOrganization", "/v1/organization", {
		payload: UpdateOrganizationRequest,
		success: Organization,
		error: [...errors, ...AuthorizationErrors],
	}),
	HttpApiEndpoint.get("listMembers", "/v1/organization/members", {
		query: {
			after: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Limit(100)),
		},
		success: Schema.Struct({
			items: Schema.Array(Member),
			next: Schema.NullOr(Schema.String),
		}),
		error: errors,
	}).annotate(Required, readMembers),
	HttpApiEndpoint.get("getMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		success: Member,
		error: memberErrors,
	}).annotate(Required, readMembers),
	HttpApiEndpoint.patch("updateMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		payload: UpdateMemberRequest,
		success: Member,
		error: [...memberErrors, RoleNotFound.pipe(HttpApiSchema.status(404))],
	})
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Changes the status, roles or extra policy of a member. A suspended member cannot sign in, and their tokens stop working.",
		),
	HttpApiEndpoint.delete("removeMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		success: HttpApiSchema.NoContent,
		error: memberErrors,
	})
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Removes a member and revokes their tokens. If their email domain is still allowed, they join again the next time they sign in. Suspend them to keep them out.",
		),
	HttpApiEndpoint.get("listInvitations", "/v1/organization/invitations", {
		query: { status: Schema.optionalKey(InvitationStatus) },
		success: Schema.Struct({ items: Schema.Array(Invitation) }),
		error: invitationErrors,
	})
		.annotate(Required, readMembers)
		.annotate(
			OpenApi.Description,
			"Lists the invitations of the organization, newest first.",
		),
	HttpApiEndpoint.post("createInvitation", "/v1/organization/invitations", {
		payload: CreateInvitationRequest,
		success: CreateInvitationResponse.pipe(HttpApiSchema.status(201)),
		error: invitationErrors,
	})
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Invites a person by email. They accept with `POST /v1/invitations/:invitationId/accept` after they sign in with that verified email. An invitation lasts 7 days. When mail is set up, OpenBot sends it and returns the delivery status. A failed send does not remove the invitation.",
		),
	HttpApiEndpoint.post(
		"resendInvitation",
		"/v1/organization/invitations/:invitationId/resend",
		{
			params: { invitationId: InvitationId },
			success: Delivery,
			error: invitationErrors,
		},
	)
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Sends a pending email invitation again. Its roles and end time stay the same. Only a Super Administrator can send an invitation with that role.",
		),
	HttpApiEndpoint.delete(
		"revokeInvitation",
		"/v1/organization/invitations/:invitationId",
		{
			params: { invitationId: InvitationId },
			success: HttpApiSchema.NoContent,
			error: invitationErrors,
		},
	)
		.annotate(Required, writeMembers)
		.annotate(OpenApi.Description, "Takes back a pending invitation."),
	HttpApiEndpoint.get("listResources", "/v1/organization/resources", {
		success: Schema.Array(ResourceInfo),
		error: errors,
	}),
	HttpApiEndpoint.get("getSettings", "/v1/organization/settings", {
		success: OrganizationSettings,
		error: [...errors, ...SettingsErrors],
	}),
	HttpApiEndpoint.patch("updateSettings", "/v1/organization/settings", {
		payload: UpdateOrganizationSettingsRequest,
		success: OrganizationSettings,
		error: [...errors, ...SettingsErrors, ...AuthorizationErrors],
	}).annotate(
		OpenApi.Description,
		"Changes the settings. Send the `version` that you read as `expectedVersion`. If someone changed the settings since then, the change fails with SettingsConflict. Every instance uses the new settings right away.",
	),
	HttpApiEndpoint.get("listRoles", "/v1/organization/roles", {
		success: Schema.Array(Role),
		error: errors,
	}).annotate(
		OpenApi.Description,
		"Lists the built-in roles and the custom roles of the organization.",
	),
	HttpApiEndpoint.get("getRole", "/v1/organization/roles/:roleId", {
		params: { roleId: RoleId },
		success: Role,
		error: roleErrors,
	}),
	HttpApiEndpoint.post("createRole", "/v1/organization/roles", {
		payload: CreateRoleRequest,
		success: Role,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Creates a custom role. Its policy cannot allow anything that you cannot do yourself.",
		),
	HttpApiEndpoint.patch("updateRole", "/v1/organization/roles/:roleId", {
		params: { roleId: RoleId },
		payload: UpdateRoleRequest,
		success: Role,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Changes a custom role. Every member with the role gets the new policy at once.",
		),
	HttpApiEndpoint.delete("deleteRole", "/v1/organization/roles/:roleId", {
		params: { roleId: RoleId },
		success: HttpApiSchema.NoContent,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Deletes a custom role. It fails with RoleInUse while a member or the default roles use it.",
		),
	HttpApiEndpoint.get("listAuditLogs", "/v1/organization/audit_logs", {
		query: {
			after: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Limit(100)),
			action: Schema.optionalKey(AuditAction),
			actor: Schema.optionalKey(Schema.String),
		},
		success: Schema.Struct({
			items: Schema.Array(AuditLogEntry),
			next: Schema.NullOr(Schema.String),
		}),
		error: errors,
	})
		.annotate(Required, [organization("read", "AuditLog")])
		.annotate(
			OpenApi.Description,
			"Lists audit log entries, newest first. `actor` filters by user ID.",
		),
) {}

/** The organizations of the caller. Any signed-in account can use these endpoints. */
export class OrganizationsApi extends HttpApiGroup.make("organizations")
	.add(
		HttpApiEndpoint.get("listOrganizations", "/v1/organizations", {
			success: Schema.Struct({ items: Schema.Array(Organization) }),
			error: errors,
		}).annotate(
			OpenApi.Description,
			"Lists the organizations where you are a member. A user token sees only its own organization.",
		),
		HttpApiEndpoint.post("createOrganization", "/v1/organizations", {
			payload: CreateOrganizationRequest,
			success: Organization,
			error: [
				...errors,
				OrganizationCreationDisabled.pipe(HttpApiSchema.status(403)),
			],
		}).annotate(
			OpenApi.Description,
			"Creates an organization. You become its Super Administrator. The platform settings say who can do this.",
		),
		HttpApiEndpoint.delete(
			"leaveOrganization",
			"/v1/organizations/:organizationId/membership",
			{
				params: { organizationId: Schema.String },
				success: HttpApiSchema.NoContent,
				error: [
					...errors,
					MemberNotFound.pipe(HttpApiSchema.status(404)),
					LastSuperAdministrator.pipe(HttpApiSchema.status(409)),
				],
			},
		).annotate(
			OpenApi.Description,
			"Leaves an organization. Your tokens in it stop working. The last active Super Administrator cannot leave. A user token can only leave its own organization.",
		),
		HttpApiEndpoint.get("listMyInvitations", "/v1/invitations", {
			success: Schema.Struct({ items: Schema.Array(Invitation) }),
			error: invitationErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the pending invitations for your verified email.",
		),
		HttpApiEndpoint.post(
			"acceptInvitation",
			"/v1/invitations/:invitationId/accept",
			{
				params: { invitationId: InvitationId },
				success: Organization,
				error: invitationErrors,
			},
		).annotate(
			OpenApi.Description,
			"Joins the organization of the invitation. You need the session cookie, and your verified email must be the email of the invitation. An invitation to use a Bot needs `POST /v1/bot-invitations/accept` instead.",
		),
		HttpApiEndpoint.post(
			"declineInvitation",
			"/v1/invitations/:invitationId/decline",
			{
				params: { invitationId: InvitationId },
				success: Invitation,
				error: invitationErrors,
			},
		).annotate(
			OpenApi.Description,
			"Says no to an invitation. You need the session cookie and the email of the invitation.",
		),
	)
	.middleware(AccountAuth)
	.middleware(NoStore) {}
