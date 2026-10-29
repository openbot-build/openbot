import {
	type Roles as RolesApi,
	OrganizationApi,
	OpenBotApi,
	Settings as SettingsApi,
} from "@openbot-build/api"

import { Authorization } from "@openbot-build/domain"
import { Account, type Caller, Identity } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	DateTime,
	Effect,
	Layer,
	Option,
	pipe,
	Struct,
} from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../errors/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { noMoreThanCaller } from "../authorization/Escalation.ts"
import { organizationKey, userKey } from "../audit/Resources.ts"
import { Roles } from "../authorization/Roles.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"
import { PlatformAdmins } from "../platform/PlatformAdmins.ts"
import { Organization } from "./Organization.ts"
import { Mail } from "../mail/Mail.ts"

const superAdministrator = "super_administrator"
const storageUnavailable = () =>
	OrganizationApi.OrganizationStorageUnavailable.make({})
/** Logs a storage failure, then fails with the public error in its place. */
const replaceStorage = (message: string) =>
	Failures.replace(message, storageUnavailable)
/**
 * The same for one storage failure that `Effect.catchTag` takes out, so the
 * other failures, such as a missing member, keep their meaning.
 */
const storageFailure =
	(message: string) =>
	<E>(error: E) =>
		Effect.fail(error).pipe(replaceStorage(message))
/** The number of rules in a policy, for the audit log. */
const ruleCount = (policy: Authorization.Policy): number => {
	const count = (node: typeof policy.node): number =>
		node._tag === "Rules"
			? node.rules.length
			: node._tag === "Ceiling"
				? count(node.cap) + count(node.policy)
				: Arr.reduce(node.policies, 0, (sum, child) => sum + count(child))
	return count(policy.node)
}

const organizationGroup = HttpApiBuilder.group(
	OpenBotApi,
	"organization",
	(handlers) =>
		Effect.gen(function* () {
			const organization = yield* Organization
			const mail = yield* Mail
			const roles = yield* Roles
			const settings = yield* Settings
			const registry = yield* ModelRegistry
			const auth = yield* Authorization.Auth
			const audit = yield* AuditLog
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				resource: string,
				details: Parameters<typeof audit.record>[0]["details"],
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource,
						details,
					})
					.pipe(replaceStorage("OpenBot could not write the audit log"))
			/**
			 * The Bot memory model must not be a `decision` model, because the
			 * memory Bot writes text. The Rules model can be either type.
			 */
			const checkModels = (
				caller: Caller,
				changes: Omit<
					SettingsApi.UpdateOrganizationSettingsRequest,
					"expectedVersion"
				>,
			) =>
				Effect.gen(function* () {
					const { botMemoryModel } = changes
					if (botMemoryModel === undefined || botMemoryModel === null) return
					const catalog = yield* registry
						.view(caller.organizationId)
						.pipe(
							Failures.replace("OpenBot could not read the model catalog", () =>
								SettingsApi.SettingsUnavailable.make({}),
							),
						)
					const model = Arr.findFirst(
						catalog.models,
						(model) =>
							model.provider === botMemoryModel.provider &&
							model.id === botMemoryModel.model,
					)
					if (Option.isSome(model) && model.value.type !== "language")
						return yield* SettingsApi.SettingsInvalid.make({
							message: `botMemoryModel cannot be a ${model.value.type} model.`,
						})
				})
			/** Fails unless the caller is a Super Administrator. */
			const requireSuperAdministrator = (
				caller: Caller,
				action: "write",
				kind: "Member" | "Organization",
			) =>
				Effect.gen(function* () {
					const self = yield* organization
						.member(caller.organizationId, caller.userId)
						.pipe(replaceStorage("OpenBot could not read the member"))
					if (
						Option.exists(self, (member) =>
							member.roles.includes(superAdministrator),
						)
					)
						return
					return yield* Authorization.Forbidden.make({
						action,
						kind,
						reason: "Only a Super Administrator can do this.",
					})
				})
			/**
			 * Only a Super Administrator can change or remove a Super Administrator,
			 * give someone the role, or give a member policy with `allow` rules.
			 * Other administrators can only take acts away with `deny` rules,
			 * so they cannot give anyone more than a role gives.
			 */
			const guardSuperAdministrator = (
				caller: Caller,
				target: OrganizationApi.Member,
				patch: OrganizationApi.UpdateMemberRequest,
			) =>
				target.roles.includes(superAdministrator) ||
				(patch.roles?.includes(superAdministrator) ?? false) ||
				(patch.policy !== undefined && !Authorization.onlyDenies(patch.policy))
					? requireSuperAdministrator(caller, "write", "Member")
					: Effect.void
			const target = (caller: Caller, userId: string) =>
				organization
					.member(caller.organizationId, userId)
					.pipe(
						replaceStorage("OpenBot could not read the member"),
						Effect.flatMap(
							Effect.fromOption(() =>
								OrganizationApi.MemberNotFound.make({ userId }),
							),
						),
					)
			const findRole = (caller: Caller, roleId: RolesApi.RoleId) =>
				roles
					.get(caller.organizationId, roleId)
					.pipe(
						replaceStorage("OpenBot could not read the role"),
						Effect.flatMap(
							Effect.fromOption(() =>
								OrganizationApi.RoleNotFound.make({ roleId }),
							),
						),
					)
			/**
			 * The `allow` rules of a role cannot give more than the caller has.
			 * Otherwise anyone who can write roles could give themselves every act.
			 */
			const checkRolePolicy = (caller: Caller, policy: Authorization.Policy) =>
				noMoreThanCaller(auth, caller, policy)

			// Write handlers do not stop when the client goes away, so a change
			// always gets its audit entry.
			return handlers
				.handle("getOrganization", () =>
					Effect.flatMap(Identity, (caller) =>
						organization.get(caller.organizationId),
					).pipe(
						// The organization of the caller must be there.
						Effect.flatMap(Effect.fromOption),
						replaceStorage("OpenBot could not read the organization"),
					),
				)
				.handle("getSettings", () =>
					Effect.flatMap(Identity, (caller) =>
						settings.organization(caller.organizationId),
					).pipe(Effect.map(Views.organization)),
				)
				.handle(
					"updateSettings",
					({ payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const { expectedVersion, ...changes } = payload
							if (changes.defaultRoles !== undefined) {
								// New members must not join as Super Administrators unless one says so.
								if (changes.defaultRoles.includes(superAdministrator))
									yield* requireSuperAdministrator(
										caller,
										"write",
										"Organization",
									)
								for (const roleId of changes.defaultRoles)
									if (
										Option.isNone(
											yield* roles
												.get(caller.organizationId, roleId)
												.pipe(
													Failures.replace(
														"OpenBot could not read the role",
														() => SettingsApi.SettingsUnavailable.make({}),
													),
												),
										)
									)
										return yield* SettingsApi.SettingsInvalid.make({
											message: `The role ${roleId} does not exist.`,
										})
							}
							yield* checkModels(caller, changes)
							const updated = yield* settings.updateOrganization(
								caller.organizationId,
								expectedVersion,
								(current) => Effect.succeed({ ...current, ...changes }),
							)
							yield* record(
								caller,
								"settings.updated",
								organizationKey(caller.organizationId),
								{ changes: Struct.keys(changes), version: updated.version },
							)
							return Views.organization(updated)
						}),
					{ uninterruptible: true },
				)
				.handle(
					"updateOrganization",
					({ payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const updated = yield* organization
								.update(caller.organizationId, payload)
								.pipe(
									replaceStorage("OpenBot could not change the organization"),
								)
							yield* record(
								caller,
								"organization.updated",
								organizationKey(caller.organizationId),
								{ changes: Struct.keys(payload) },
							)
							return updated
						}),
					{ uninterruptible: true },
				)
				.handle("listMembers", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						organization.listMembers(caller.organizationId, {
							...(query.after === undefined ? {} : { after: query.after }),
							limit: query.limit ?? 50,
						}),
					).pipe(replaceStorage("OpenBot could not list the members")),
				)
				.handle("getMember", ({ params }) =>
					Effect.flatMap(Identity, (caller) => target(caller, params.userId)),
				)
				.handle(
					"updateMember",
					({ params, payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const member = yield* target(caller, params.userId)
							if (payload.roles !== undefined)
								yield* Effect.forEach(
									payload.roles,
									(id) => findRole(caller, id),
									{ discard: true },
								)
							yield* guardSuperAdministrator(caller, member, payload)
							const updated = yield* organization
								.updateMember(caller.organizationId, params.userId, payload)
								.pipe(
									Effect.catchTag(
										"OrganizationUnavailable",
										storageFailure("OpenBot could not change the member"),
									),
								)
							yield* record(
								caller,
								"member.updated",
								userKey({
									organizationId: caller.organizationId,
									userId: params.userId,
								}),
								{
									before: {
										status: member.status,
										roles: [...member.roles],
										policyRules: ruleCount(member.policy),
									},
									after: {
										status: updated.status,
										roles: [...updated.roles],
										policyRules: ruleCount(updated.policy),
									},
								},
							)
							return updated
						}),
					{ uninterruptible: true },
				)
				.handle(
					"removeMember",
					({ params }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const member = yield* target(caller, params.userId)
							yield* guardSuperAdministrator(caller, member, {})
							yield* organization
								.removeMember(caller.organizationId, params.userId)
								.pipe(
									Effect.catchTag(
										"OrganizationUnavailable",
										storageFailure("OpenBot could not remove the member"),
									),
								)
							yield* record(
								caller,
								"member.removed",
								userKey({
									organizationId: caller.organizationId,
									userId: params.userId,
								}),
								{ roles: [...member.roles] },
							)
						}),
					{ uninterruptible: true },
				)
				.handle("listInvitations", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						organization.listInvitations(caller.organizationId, query.status),
					).pipe(
						Effect.map((items) => ({ items })),
						replaceStorage("OpenBot could not list the invitations"),
					),
				)
				.handle(
					"createInvitation",
					({ payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const invited =
								payload.roles ??
								(yield* settings
									.organization(caller.organizationId)
									.pipe(
										replaceStorage(
											"OpenBot could not read the organization settings",
										),
									)).document.defaultRoles
							for (const roleId of invited) yield* findRole(caller, roleId)
							// Only a Super Administrator can give the Super Administrator role.
							if (invited.includes(superAdministrator))
								yield* requireSuperAdministrator(caller, "write", "Member")
							const invitation = yield* organization
								.createInvitation({
									organizationId: caller.organizationId,
									email: payload.email,
									roles: invited,
									invitedBy: caller.userId,
								})
								.pipe(
									Effect.catchTag(
										"OrganizationUnavailable",
										storageFailure("OpenBot could not make the invitation"),
									),
								)
							yield* record(
								caller,
								"invitation.created",
								organizationKey(caller.organizationId),
								{
									invitationId: invitation.id,
									email: invitation.email,
									roles: [...invitation.roles],
								},
							)
							const delivery = yield* mail.invitation({
								id: invitation.id,
								email: invitation.email,
								organizationName: invitation.organizationName,
								expiresAt: DateTime.toEpochMillis(
									DateTime.makeUnsafe(invitation.expiresAt),
								),
							})
							return { ...invitation, delivery }
						}),
					{ uninterruptible: true },
				)
				.handle(
					"resendInvitation",
					({ params }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const invitations = yield* organization
								.listInvitations(caller.organizationId)
								.pipe(replaceStorage("OpenBot could not read the invitation"))
							const invitation = yield* Effect.fromOption(
								Arr.findFirst(
									invitations,
									(item) => item.id === params.invitationId,
								),
								() =>
									OrganizationApi.InvitationNotFound.make({
										invitationId: params.invitationId,
									}),
							)
							const expiresAt = DateTime.toEpochMillis(
								DateTime.makeUnsafe(invitation.expiresAt),
							)
							if (
								invitation.status !== "pending" ||
								expiresAt <= (yield* Clock.currentTimeMillis)
							)
								return yield* OrganizationApi.InvitationInvalid.make({
									message:
										"Only a pending invitation that has not ended can be sent.",
								})
							if (invitation.roles.includes(superAdministrator))
								yield* requireSuperAdministrator(caller, "write", "Member")
							yield* record(
								caller,
								"invitation.send_requested",
								organizationKey(caller.organizationId),
								{
									invitationId: invitation.id,
								},
							)
							return yield* mail.invitation({
								id: invitation.id,
								email: invitation.email,
								organizationName: invitation.organizationName,
								expiresAt,
							})
						}),
					{ uninterruptible: true },
				)
				.handle(
					"revokeInvitation",
					({ params }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const invitation = yield* organization
								.revokeInvitation(caller.organizationId, params.invitationId)
								.pipe(
									Effect.catchTag(
										"OrganizationUnavailable",
										storageFailure(
											"OpenBot could not take back the invitation",
										),
									),
								)
							yield* record(
								caller,
								"invitation.revoked",
								organizationKey(caller.organizationId),
								{ invitationId: invitation.id, email: invitation.email },
							)
						}),
					{ uninterruptible: true },
				)
				.handle("listResources", () =>
					Effect.succeed(Authorization.resourceInfo),
				)
				.handle("listRoles", () =>
					Effect.flatMap(Identity, (caller) =>
						roles.list(caller.organizationId),
					).pipe(replaceStorage("OpenBot could not list the roles")),
				)
				.handle("getRole", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						return yield* findRole(caller, params.roleId)
					}),
				)
				.handle(
					"createRole",
					({ payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							yield* checkRolePolicy(caller, payload.policy)
							const role = yield* roles
								.create(caller.organizationId, payload)
								.pipe(replaceStorage("OpenBot could not make the role"))
							yield* record(
								caller,
								"role.created",
								organizationKey(caller.organizationId),
								{ roleId: role.id, name: role.name },
							)
							return role
						}),
					{ uninterruptible: true },
				)
				.handle(
					"updateRole",
					({ params, payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							yield* findRole(caller, params.roleId)
							if (payload.policy !== undefined)
								yield* checkRolePolicy(caller, payload.policy)
							const role = yield* roles
								.update(caller.organizationId, params.roleId, payload)
								.pipe(
									Effect.catchTag(
										"RolesUnavailable",
										storageFailure("OpenBot could not change the role"),
									),
								)
							yield* record(
								caller,
								"role.updated",
								organizationKey(caller.organizationId),
								{ roleId: role.id, changes: Struct.keys(payload) },
							)
							return role
						}),
					{ uninterruptible: true },
				)
				.handle(
					"deleteRole",
					({ params }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const role = yield* findRole(caller, params.roleId)
							if (role.builtin)
								return yield* OrganizationApi.RoleReadOnly.make({
									roleId: role.id,
								})
							if (
								yield* organization
									.roleInUse(caller.organizationId, role.id)
									.pipe(
										replaceStorage(
											"OpenBot could not check if a member uses the role",
										),
									)
							)
								return yield* OrganizationApi.RoleInUse.make({
									roleId: role.id,
								})
							yield* roles
								.delete(caller.organizationId, role.id)
								.pipe(
									Effect.catchTag(
										"RolesUnavailable",
										storageFailure("OpenBot could not delete the role"),
									),
								)
							yield* record(
								caller,
								"role.deleted",
								organizationKey(caller.organizationId),
								{ roleId: role.id, name: role.name },
							)
						}),
					{ uninterruptible: true },
				)
				.handle("listAuditLogs", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						audit.list(caller.organizationId, {
							...(query.after === undefined ? {} : { after: query.after }),
							...(query.action === undefined ? {} : { action: query.action }),
							...(query.actor === undefined ? {} : { actor: query.actor }),
							limit: query.limit ?? 50,
						}),
					).pipe(replaceStorage("OpenBot could not read the audit log")),
				)
		}),
)

/** The organizations of the caller, and new organizations. */
const organizationsGroup = HttpApiBuilder.group(
	OpenBotApi,
	"organizations",
	(handlers) =>
		Effect.gen(function* () {
			const organization = yield* Organization
			const settings = yield* Settings
			const admins = yield* PlatformAdmins
			const audit = yield* AuditLog
			/** Records a change that the account made in one organization. */
			const record = (
				userId: string,
				organizationId: string,
				action: OrganizationApi.AuditAction,
				details: Parameters<typeof audit.record>[0]["details"],
			) =>
				audit
					.record({
						organizationId,
						action,
						actor: { kind: "member", userId, organizationId },
						resource: userKey({ organizationId, userId }),
						details,
					})
					.pipe(replaceStorage("OpenBot could not write the audit log"))
			/** An answer to an invitation needs the session cookie, not a token of one organization. */
			const answer = (invitationId: string, answer: "accepted" | "declined") =>
				Effect.gen(function* () {
					const account = yield* Account
					if (account.tokenId !== undefined)
						return yield* OrganizationApi.InvitationInvalid.make({
							message: "Use the session cookie to answer an invitation.",
						})
					const invitation = yield* organization
						.answerInvitation(account.userId, invitationId, answer)
						.pipe(
							Effect.catchTag(
								"OrganizationUnavailable",
								storageFailure("OpenBot could not answer the invitation"),
							),
						)
					yield* record(
						account.userId,
						invitation.organizationId,
						answer === "accepted"
							? "invitation.accepted"
							: "invitation.declined",
						{ invitationId: invitation.id },
					)
					return invitation
				})
			// Write handlers do not stop when the client goes away, so a change
			// always gets its audit entry.
			return handlers
				.handle("listOrganizations", () =>
					Effect.gen(function* () {
						const account = yield* Account
						const memberships = yield* organization.memberships(account.userId)
						const ids = pipe(
							memberships,
							// A token sees only its own organization.
							Arr.filter(
								(membership) =>
									account.organizationId === undefined ||
									membership.organizationId === account.organizationId,
							),
							Arr.map((membership) => membership.organizationId),
						)
						const found = yield* Effect.forEach(ids, (id) =>
							organization.get(id),
						)
						return { items: Arr.getSomes(found) }
					}).pipe(replaceStorage("OpenBot could not list the organizations")),
				)
				.handle(
					"createOrganization",
					({ payload }) =>
						Effect.gen(function* () {
							const account = yield* Account
							const platform = yield* settings.platform.pipe(
								replaceStorage("OpenBot could not read the platform settings"),
							)
							const anyone = Option.exists(
								platform,
								(platform) =>
									platform.document.organizationCreation === "anyone",
							)
							if (
								!anyone &&
								!(yield* admins
									.check({ id: account.userId })
									.pipe(
										replaceStorage(
											"OpenBot could not check the platform admins",
										),
									))
							)
								return yield* OrganizationApi.OrganizationCreationDisabled.make(
									{},
								)
							return yield* organization
								.create({ name: payload.name, owner: { id: account.userId } })
								.pipe(replaceStorage("OpenBot could not make the organization"))
						}),
					{ uninterruptible: true },
				)
				.handle(
					"leaveOrganization",
					({ params }) =>
						Effect.gen(function* () {
							const account = yield* Account
							// A token belongs to one organization, so it can only leave that one.
							if (
								account.organizationId !== undefined &&
								account.organizationId !== params.organizationId
							)
								return yield* OrganizationApi.MemberNotFound.make({
									userId: account.userId,
								})
							yield* organization
								.removeMember(params.organizationId, account.userId)
								.pipe(
									Effect.catchTag(
										"OrganizationUnavailable",
										storageFailure("OpenBot could not remove the member"),
									),
								)
							yield* record(
								account.userId,
								params.organizationId,
								"member.left",
								{},
							)
						}),
					{ uninterruptible: true },
				)
				.handle("listMyInvitations", () =>
					Effect.flatMap(Account, (account) =>
						organization.invitationsFor(account.userId),
					).pipe(
						Effect.map((items) => ({ items })),
						replaceStorage("OpenBot could not list the invitations"),
					),
				)
				.handle(
					"acceptInvitation",
					({ params }) =>
						Effect.gen(function* () {
							const invitation = yield* answer(params.invitationId, "accepted")
							return yield* organization.get(invitation.organizationId).pipe(
								// The organization of an accepted invitation must be there.
								Effect.flatMap(Effect.fromOption),
								replaceStorage(
									"OpenBot could not read the organization of the invitation",
								),
							)
						}),
					{ uninterruptible: true },
				)
				.handle(
					"declineInvitation",
					({ params }) => answer(params.invitationId, "declined"),
					{ uninterruptible: true },
				)
		}),
)

export const layer = Layer.merge(organizationGroup, organizationsGroup)
