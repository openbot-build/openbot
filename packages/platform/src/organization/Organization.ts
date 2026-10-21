import type { OrganizationApi } from "@openbot-build/platform-api"
import { Context, type Effect, type Option, Schema } from "effect"

/** The account is not an active member, and it cannot join on its own. */
export class MembershipRejected extends Schema.TaggedError<MembershipRejected>()(
	"MembershipRejected",
	{},
) {}
export class OrganizationUnavailable extends Schema.TaggedError<OrganizationUnavailable>()(
	"OrganizationUnavailable",
	{},
) {}

/** Settings that only the deployment controls. */
export interface Options {
	/** People with these verified emails join as Super Administrators. */
	readonly ownerEmails?: ReadonlyArray<string>
	/** The allowed email domains of a new organization. After that, the API owns them. */
	readonly allowedEmailDomains?: ReadonlyArray<string>
}

export interface Account {
	readonly id: string
	readonly email?: string | undefined
	readonly name?: string | undefined
	readonly emailVerified?: boolean | undefined
}

export interface Page {
	readonly items: ReadonlyArray<OrganizationApi.Member>
	readonly next: string | null
}

/**
 * The one organization of a deployment and its members.
 * The first account to sign in creates it and becomes a Super Administrator.
 */
export class Organization extends Context.Service<
	Organization,
	{
		/** Find the member for a signed-in account. A new account joins when the rules allow it. */
		readonly admit: (
			account: Account,
		) => Effect.Effect<
			{ readonly organizationId: string; readonly joined: boolean },
			MembershipRejected | OrganizationUnavailable
		>
		readonly member: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<
			Option.Option<OrganizationApi.Member>,
			OrganizationUnavailable
		>
		readonly get: (
			organizationId: string,
		) => Effect.Effect<OrganizationApi.Organization, OrganizationUnavailable>
		readonly update: (
			organizationId: string,
			patch: OrganizationApi.UpdateOrganizationRequest,
		) => Effect.Effect<OrganizationApi.Organization, OrganizationUnavailable>
		readonly listMembers: (
			organizationId: string,
			options: { readonly after?: string; readonly limit: number },
		) => Effect.Effect<Page, OrganizationUnavailable>
		/** Fails with LastSuperAdministrator when no active Super Administrator would be left. */
		readonly updateMember: (
			organizationId: string,
			userId: string,
			patch: OrganizationApi.UpdateMemberRequest,
		) => Effect.Effect<
			OrganizationApi.Member,
			| OrganizationApi.MemberNotFound
			| OrganizationApi.LastSuperAdministrator
			| OrganizationUnavailable
		>
		/** Removes the member and their tokens. */
		readonly removeMember: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<
			void,
			| OrganizationApi.MemberNotFound
			| OrganizationApi.LastSuperAdministrator
			| OrganizationUnavailable
		>
	}
>()("@openbot-build/platform/organization/Organization") {}
