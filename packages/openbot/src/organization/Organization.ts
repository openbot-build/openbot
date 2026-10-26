import type {
	BotsApi,
	AuthApi,
	OrganizationApi,
	PlatformApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	type Effect,
	type Option,
	pipe,
	Schema,
	String as Str,
} from "effect"

/** OpenBot cannot read or write the organizations now. */
export class OrganizationUnavailable extends Schema.TaggedError<
	OrganizationUnavailable,
	{ readonly brand: unique symbol }
>()("OrganizationUnavailable", { cause: Schema.Defect() }) {}

/** The secret of an invitation link: its SHA-256 hash, the sealed secret and its first characters. */
export interface LinkSecret {
	readonly hash: string
	readonly sealed: string
	readonly prefix: string
}

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
		 * that organization lets people join by domain. It never makes an organization:
		 * an account can have no organization at all.
		 * `only` limits joining to one organization, such as the owner of an SSO connection.
		 */
		readonly admit: (
			account: Account,
			only: Option.Option<string>,
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
		/** The invitations of an organization, newest first. */
		readonly listInvitations: (
			organizationId: string,
			status?: OrganizationApi.InvitationStatus,
		) => Effect.Effect<
			ReadonlyArray<OrganizationApi.Invitation>,
			OrganizationUnavailable
		>
		/**
		 * Invites an email to an organization. Fails when the email already has a
		 * pending invitation or belongs to a member.
		 */
		readonly createInvitation: (input: {
			readonly organizationId: string
			readonly email: string
			readonly roles: ReadonlyArray<string>
			readonly invitedBy: string
		}) => Effect.Effect<
			OrganizationApi.Invitation,
			OrganizationApi.InvitationInvalid | OrganizationUnavailable
		>
		/** Takes back a pending invitation. */
		readonly revokeInvitation: (
			organizationId: string,
			invitationId: string,
		) => Effect.Effect<
			OrganizationApi.Invitation,
			| OrganizationApi.InvitationNotFound
			| OrganizationApi.InvitationInvalid
			| OrganizationUnavailable
		>
		/** The pending invitations for the verified email of a user. */
		readonly invitationsFor: (
			userId: string,
		) => Effect.Effect<
			ReadonlyArray<OrganizationApi.Invitation>,
			OrganizationUnavailable
		>
		/**
		 * Answers an invitation for the verified email of a user.
		 * Accepting makes the user a member with the roles of the invitation.
		 * An invitation for another email is not found.
		 */
		readonly answerInvitation: (
			userId: string,
			invitationId: string,
			answer: "accepted" | "declined",
		) => Effect.Effect<
			OrganizationApi.Invitation,
			| OrganizationApi.InvitationNotFound
			| OrganizationApi.InvitationInvalid
			| OrganizationUnavailable
		>
		/** The invitations to use one Bot of an organization, newest first. */
		readonly listBotInvitations: (
			organizationId: string,
			bot: string,
			status?: OrganizationApi.InvitationStatus,
		) => Effect.Effect<
			ReadonlyArray<BotsApi.BotInvitation>,
			OrganizationUnavailable
		>
		/**
		 * Invites an email, or makes an invitation link, to use one Bot.
		 * A link has `link`: the hash of its secret, its sealed secret and its prefix.
		 */
		readonly createBotInvitation: (input: {
			readonly organizationId: string
			readonly bot: { readonly id: string; readonly name: string }
			readonly email?: string
			readonly link?: LinkSecret
			readonly expiresAt?: number
			readonly path?: string
			readonly invitedBy: string
		}) => Effect.Effect<
			BotsApi.BotInvitation,
			OrganizationApi.InvitationInvalid | OrganizationUnavailable
		>
		/** One invitation to use a Bot, with the secret of a link. */
		readonly botInvitation: (
			organizationId: string,
			bot: string,
			invitationId: string,
		) => Effect.Effect<
			{
				readonly invitation: BotsApi.BotInvitation
				readonly link: LinkSecret | null
			},
			OrganizationApi.InvitationNotFound | OrganizationUnavailable
		>
		readonly revokeBotInvitation: (
			organizationId: string,
			bot: string,
			invitationId: string,
		) => Effect.Effect<
			BotsApi.BotInvitation,
			| OrganizationApi.InvitationNotFound
			| OrganizationApi.InvitationInvalid
			| OrganizationUnavailable
		>
		/**
		 * Uses an invitation to a Bot for a user: an email invitation for their verified
		 * email, which then counts as accepted, or a link by the hash of its secret, which
		 * stays open for other people. Gives back the Bot and its organization.
		 */
		readonly takeBotInvitation: (
			userId: string,
			by:
				| { readonly _tag: "Email"; readonly invitationId: string }
				| { readonly _tag: "Link"; readonly secretHash: string },
		) => Effect.Effect<
			{
				readonly invitationId: string
				readonly organizationId: string
				readonly bot: string
			},
			| OrganizationApi.InvitationNotFound
			| OrganizationApi.InvitationInvalid
			| OrganizationUnavailable
		>
		/** Whether a member or the default roles use a role. */
		readonly roleInUse: (
			organizationId: string,
			roleId: string,
		) => Effect.Effect<boolean, OrganizationUnavailable>
	}
>()("@openbot-build/openbot/organization/Organization") {}

/** The part of an email after its last "@", in lower case. */
export const domainOf = (email: string) =>
	pipe(email, Str.split("@"), Arr.lastNonEmpty, Str.toLowerCase)
