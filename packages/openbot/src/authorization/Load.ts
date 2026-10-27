import {
	type Settings as SettingsModel,
	type Tokens as TokensModel,
} from "@openbot-build/domain"

import { Authorization } from "@openbot-build/domain"
import { type AccountCaller } from "@openbot-build/domain"
import { Policy } from "@nmnmcc/ability"
import { Array as Arr, Clock, DateTime, Effect, Option, pipe } from "effect"
import { Tokens } from "../auth/Tokens.ts"
import {
	Organization,
	type OrganizationUnavailable,
} from "../organization/Organization.ts"
import {
	PlatformAdmins,
	type PlatformAdminsUnavailable,
} from "../platform/PlatformAdmins.ts"
import { Settings } from "../settings/Settings.ts"
import { Roles, type RolesUnavailable } from "./Roles.ts"

export type Services = Organization | Tokens | Roles | Settings | PlatformAdmins

type OpenBotPolicy = Authorization.Policy

/** The storage errors while loading a policy. A check turns them into `PolicyUnavailable`. */
export type Unavailable =
	| OrganizationUnavailable
	| TokensModel.TokenStorageUnavailable
	| RolesUnavailable
	| SettingsModel.SettingsUnavailable
	| PlatformAdminsUnavailable

const define = Policy.define(Authorization.OpenBot)

/**
 * Lets a rule act only in the organization of the caller. Every policy of a
 * member goes through it, so a role or a member policy can never name another
 * organization.
 */
const organizationScope = define(function* (_) {
	yield* _.allow("*", "*", {
		when: ($) => $.under("org", $.principal("organizationId")),
	})
})

/** Platform admins may act on the platform. */
const platformAdmin = define(function* (_) {
	yield* _.allow("*", Authorization.Platform)
})

/**
 * Puts policies together so that a deny in one of them wins, and otherwise an
 * allow in one of them is enough. It is the same as one list of all their
 * rules with `denyOverrides`. `Policy.all` gives the deny of any child, and
 * `Policy.any` gives the allow of any child.
 */
export const overriding = (
	policies: ReadonlyArray<OpenBotPolicy>,
): OpenBotPolicy => {
	const [first, ...rest] = policies
	if (first === undefined) return Authorization.emptyPolicy
	if (rest.length === 0) return first
	return Policy.ceiling(
		Policy.any([first, ...rest]),
		Policy.all([first, ...rest]),
	)
}

/** The policy of an active member: the policies of the roles, and the member policy. */
export const memberPolicy = (input: {
	readonly member: {
		readonly roles: ReadonlyArray<string>
		readonly policy: OpenBotPolicy
	}
	readonly roles: ReadonlyArray<{
		readonly id: string
		readonly policy: OpenBotPolicy
	}>
}): OpenBotPolicy =>
	Policy.all([
		overriding([
			...pipe(
				input.roles,
				Arr.filter((role) => input.member.roles.includes(role.id)),
				Arr.map((role) => role.policy),
			),
			input.member.policy,
		]),
		organizationScope,
	])

/**
 * Loads the policy of a caller:
 *
 * - An active member gets the policies of their roles and their own policy,
 *   inside their organization. The platform ceiling comes on top.
 * - With `platform`, a platform admin may also act on the platform. Only the
 *   platform API asks for it, so other requests do not read the admin list.
 * - A user token must also allow the act with its own policy, so it never
 *   does more than its member.
 *
 * Any other caller gets an empty policy, which allows nothing.
 */
export const policyOf = (
	caller: AccountCaller,
	options: { readonly platform: boolean },
): Effect.Effect<OpenBotPolicy, Unavailable, Services> =>
	Effect.gen(function* () {
		const organization = yield* Organization
		const tokens = yield* Tokens
		const roles = yield* Roles
		const settings = yield* Settings
		const admins = yield* PlatformAdmins
		const ceiling = Option.match(yield* settings.platform, {
			onNone: () => Authorization.emptyPolicy,
			onSome: (platform) => platform.document.ceiling,
		})
		let member = Authorization.emptyPolicy
		if (caller.organizationId !== undefined) {
			const found = yield* organization.activeMember(
				caller.organizationId,
				caller.userId,
			)
			if (Option.isSome(found))
				member = memberPolicy({
					member: found.value,
					roles: yield* roles.list(caller.organizationId),
				}).pipe(Policy.ceiling(ceiling))
		}
		const policy =
			options.platform && (yield* admins.check({ id: caller.userId }))
				? Policy.any([member, platformAdmin])
				: member
		if (caller.kind === "member") return policy
		if (caller.organizationId === undefined) return Authorization.emptyPolicy
		const token = yield* tokens.find(
			{ organizationId: caller.organizationId, userId: caller.userId },
			caller.tokenId,
		)
		const now = yield* Clock.currentTimeMillis
		return Option.match(token, {
			onNone: () => Authorization.emptyPolicy,
			onSome: (token) =>
				token.expiresAt !== null &&
				!Option.exists(
					DateTime.make(token.expiresAt),
					(expires) => DateTime.toEpochMillis(expires) > now,
				)
					? Authorization.emptyPolicy
					: Policy.all([policy, token.policy]),
		})
	})
