import type { AuthApi, OrganizationApi, PlatformApi } from "@openbot-build/api"
import { Context, type Effect, type Option, Schema } from "effect"

export class OrganizationUnavailable extends Schema.TaggedError<OrganizationUnavailable>()(
	"OrganizationUnavailable",
	{},
) {}

export interface Account {
	readonly id: string
	readonly email?: string | undefined
	readonly name?: string | undefined
	readonly emailVerified?: boolean | undefined
}

export interface Page<A> {
	readonly items: ReadonlyArray<A>
	readonly next: string | null
}

/**
 * The organizations of the platform and their members.
 * One account can be a member of many organizations.
 */
export class Organization extends Context.Service<
	Organization,
	{
		/**
		 * Runs when an account signs in or uses the session cookie.
		 * The account joins the organization that verified its email domain, when
		 * that organization lets people join by domain. An account with no
		 * organization gets a personal one, when the platform lets anyone create one.
		 * `only` limits joining to one organization, such as the owner of an SSO connection.
		 */
		readonly admit: (
			account: Account,
			options?: { readonly only?: string },
		) => Effect.Effect<
			ReadonlyArray<AuthApi.Membership>,
			OrganizationUnavailable
		>
		/** The organizations of an account, with the status of each membership. */
		readonly memberships: (
			userId: string,
		) => Effect.Effect<
			ReadonlyArray<AuthApi.Membership>,
			OrganizationUnavailable
		>
		readonly member: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<
			Option.Option<OrganizationApi.Member>,
			OrganizationUnavailable
		>
		/** The member, only when both the member and the organization are active. */
		readonly activeMember: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<
			Option.Option<OrganizationApi.Member>,
			OrganizationUnavailable
		>
		readonly get: (
			organizationId: string,
		) => Effect.Effect<
			Option.Option<OrganizationApi.Organization>,
			OrganizationUnavailable
		>
		/** Every organization of the platform, for platform admins. */
		readonly list: (options: {
			readonly after?: string
			readonly limit: number
		}) => Effect.Effect<
			Page<OrganizationApi.Organization>,
			OrganizationUnavailable
		>
		/** Creates an organization. The owner becomes its Super Administrator. */
		readonly create: (input: {
			readonly name: string
			readonly owner: Account
		}) => Effect.Effect<OrganizationApi.Organization, OrganizationUnavailable>
		readonly update: (
			organizationId: string,
			patch: OrganizationApi.UpdateOrganizationRequest,
		) => Effect.Effect<OrganizationApi.Organization, OrganizationUnavailable>
		readonly setStatus: (
			organizationId: string,
			status: OrganizationApi.Organization["status"],
		) => Effect.Effect<
			OrganizationApi.Organization,
			PlatformApi.OrganizationNotFound | OrganizationUnavailable
		>
		readonly listMembers: (
			organizationId: string,
			options: { readonly after?: string; readonly limit: number },
		) => Effect.Effect<Page<OrganizationApi.Member>, OrganizationUnavailable>
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
		/** Whether a member or the default roles use a role. */
		readonly roleInUse: (
			organizationId: string,
			roleId: string,
		) => Effect.Effect<boolean, OrganizationUnavailable>
	}
>()("@openbot-build/openbot/organization/Organization") {}

export const domainOf = (email: string) =>
	email.slice(email.lastIndexOf("@") + 1).toLowerCase()
