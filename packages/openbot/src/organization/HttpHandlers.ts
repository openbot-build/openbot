import {
	Account,
	type Caller,
	Identity,
	Authorization,
	OrganizationApi,
	OpenBotApi,
	Settings as SettingsApi,
} from "@openbot-build/api"
import { Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import { noMoreThanCaller } from "../authorization/Escalation.ts"
import { organizationKey, userKey } from "../audit/Resources.ts"
import { Roles } from "../authorization/Roles.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"
import { PlatformAdmins } from "../platform/PlatformAdmins.ts"
import { Organization, type OrganizationUnavailable } from "./Organization.ts"

const superAdministrator = "super_administrator"
/** The number of rules in a policy, for the audit log. */
const ruleCount = (policy: Authorization.Policy): number => {
	const count = (node: typeof policy.node): number =>
		node._tag === "Rules"
			? node.rules.length
			: node._tag === "Ceiling"
				? count(node.cap) + count(node.policy)
				: node.policies.reduce((sum, child) => sum + count(child), 0)
	return count(policy.node)
}
const unavailable = () =>
	OrganizationApi.OrganizationStorageUnavailable.make({})

const organizationGroup = HttpApiBuilder.group(
	OpenBotApi,
	"organization",
	(handlers) =>
		Effect.gen(function* () {
			const organization = yield* Organization
			const roles = yield* Roles
			const settings = yield* Settings
			const registry = yield* ModelRegistry
			const services = yield* Effect.context<AuthorizationServices>()
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
					.pipe(Effect.mapError(unavailable))
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
							Effect.mapError(() => SettingsApi.SettingsUnavailable.make({})),
						)
					const type = catalog.models.find(
						(model) =>
							model.provider === botMemoryModel.provider &&
							model.id === botMemoryModel.model,
					)?.type
					if (type === "decision")
						return yield* SettingsApi.SettingsInvalid.make({
							message: "botMemoryModel cannot be a decision model.",
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
						.pipe(Effect.mapError(unavailable))
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
				organization.member(caller.organizationId, userId).pipe(
					Effect.mapError(unavailable),
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(OrganizationApi.MemberNotFound.make({ userId })),
							onSome: Effect.succeed,
						}),
					),
				)
			const storageError = (
				error:
					| OrganizationApi.MemberNotFound
					| OrganizationApi.LastSuperAdministrator
					| OrganizationUnavailable,
			) => (error._tag === "OrganizationUnavailable" ? unavailable() : error)

			const roleError = (
				error:
					| OrganizationApi.RoleNotFound
					| OrganizationApi.RoleReadOnly
					| { readonly _tag: "RolesUnavailable" },
			) => (error._tag === "RolesUnavailable" ? unavailable() : error)
			const findRole = (caller: Caller, roleId: string) =>
				roles.get(caller.organizationId, roleId).pipe(
					Effect.mapError(unavailable),
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(OrganizationApi.RoleNotFound.make({ roleId })),
							onSome: Effect.succeed,
						}),
					),
				)
			/**
			 * The `allow` rules of a role cannot give more than the caller has.
			 * Otherwise anyone who can write roles could give themselves every act.
			 */
			const checkRolePolicy = (caller: Caller, policy: Authorization.Policy) =>
				noMoreThanCaller(caller, policy).pipe(Effect.provideContext(services))

			return handlers
				.handle("getOrganization", () =>
					Effect.flatMap(Identity, (caller) =>
						organization.get(caller.organizationId),
					).pipe(
						Effect.mapError(unavailable),
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.fail(unavailable()),
								onSome: Effect.succeed,
							}),
						),
					),
				)
				.handle("getSettings", () =>
					Effect.flatMap(Identity, (caller) =>
						settings.organization(caller.organizationId),
					).pipe(Effect.map(Views.organization)),
				)
				.handle("updateSettings", ({ payload }) =>
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
												Effect.mapError(() =>
													SettingsApi.SettingsUnavailable.make({}),
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
							{ changes: Object.keys(changes), version: updated.version },
						)
						return Views.organization(updated)
					}),
				)
				.handle("updateOrganization", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const updated = yield* organization
							.update(caller.organizationId, payload)
							.pipe(Effect.mapError(unavailable))
						yield* record(
							caller,
							"organization.updated",
							organizationKey(caller.organizationId),
							{ changes: Object.keys(payload) },
						)
						return updated
					}),
				)
				.handle("listMembers", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						organization.listMembers(caller.organizationId, {
							...(query.after === undefined ? {} : { after: query.after }),
							limit: query.limit ?? 50,
						}),
					).pipe(Effect.mapError(unavailable)),
				)
				.handle("getMember", ({ params }) =>
					Effect.flatMap(Identity, (caller) => target(caller, params.userId)),
				)
				.handle("updateMember", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const member = yield* target(caller, params.userId)
						yield* guardSuperAdministrator(caller, member, payload)
						const updated = yield* organization
							.updateMember(caller.organizationId, params.userId, payload)
							.pipe(Effect.mapError(storageError))
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
				)
				.handle("removeMember", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const member = yield* target(caller, params.userId)
						yield* guardSuperAdministrator(caller, member, {})
						yield* organization
							.removeMember(caller.organizationId, params.userId)
							.pipe(Effect.mapError(storageError))
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
				)
				.handle("listInvitations", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						organization.listInvitations(caller.organizationId, query.status),
					).pipe(
						Effect.map((items) => ({ items })),
						Effect.mapError(unavailable),
					),
				)
				.handle("createInvitation", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const invited =
							payload.roles ??
							(yield* settings
								.organization(caller.organizationId)
								.pipe(Effect.mapError(unavailable))).document.defaultRoles
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
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
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
						return invitation
					}),
				)
				.handle("revokeInvitation", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const invitation = yield* organization
							.revokeInvitation(caller.organizationId, params.invitationId)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
								),
							)
						yield* record(
							caller,
							"invitation.revoked",
							organizationKey(caller.organizationId),
							{ invitationId: invitation.id, email: invitation.email },
						)
					}),
				)
				.handle("listResources", () =>
					Effect.succeed(Authorization.resourceInfo),
				)
				.handle("listRoles", () =>
					Effect.flatMap(Identity, (caller) =>
						roles.list(caller.organizationId),
					).pipe(Effect.mapError(unavailable)),
				)
				.handle("getRole", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						return yield* findRole(caller, params.roleId)
					}),
				)
				.handle("createRole", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* checkRolePolicy(caller, payload.policy)
						const role = yield* roles
							.create(caller.organizationId, payload)
							.pipe(Effect.mapError(unavailable))
						yield* record(
							caller,
							"role.created",
							organizationKey(caller.organizationId),
							{ roleId: role.id, name: role.name },
						)
						return role
					}),
				)
				.handle("updateRole", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* findRole(caller, params.roleId)
						if (payload.policy !== undefined)
							yield* checkRolePolicy(caller, payload.policy)
						const role = yield* roles
							.update(caller.organizationId, params.roleId, payload)
							.pipe(Effect.mapError(roleError))
						yield* record(
							caller,
							"role.updated",
							organizationKey(caller.organizationId),
							{ roleId: role.id, changes: Object.keys(payload) },
						)
						return role
					}),
				)
				.handle("deleteRole", ({ params }) =>
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
								.pipe(Effect.mapError(unavailable))
						)
							return yield* OrganizationApi.RoleInUse.make({ roleId: role.id })
						yield* roles
							.delete(caller.organizationId, role.id)
							.pipe(Effect.mapError(roleError))
						yield* record(
							caller,
							"role.deleted",
							organizationKey(caller.organizationId),
							{ roleId: role.id, name: role.name },
						)
					}),
				)
				.handle("listAuditLogs", ({ query }) =>
					Effect.flatMap(Identity, (caller) =>
						audit.list(caller.organizationId, {
							...(query.after === undefined ? {} : { after: query.after }),
							...(query.action === undefined ? {} : { action: query.action }),
							...(query.actor === undefined ? {} : { actor: query.actor }),
							limit: query.limit ?? 50,
						}),
					).pipe(Effect.mapError(unavailable)),
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
					.pipe(Effect.mapError(unavailable))
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
							Effect.mapError((error) =>
								error._tag === "OrganizationUnavailable"
									? unavailable()
									: error,
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
			return handlers
				.handle("listOrganizations", () =>
					Effect.gen(function* () {
						const account = yield* Account
						const memberships = yield* organization.memberships(account.userId)
						const ids = memberships
							// A token sees only its own organization.
							.filter(
								(membership) =>
									account.organizationId === undefined ||
									membership.organizationId === account.organizationId,
							)
							.map((membership) => membership.organizationId)
						const items: Array<OrganizationApi.Organization> = []
						for (const id of ids) {
							const found = yield* organization.get(id)
							if (Option.isSome(found)) items.push(found.value)
						}
						return { items }
					}).pipe(Effect.mapError(unavailable)),
				)
				.handle("createOrganization", ({ payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const platform = yield* settings.platform.pipe(
							Effect.mapError(unavailable),
						)
						const anyone = Option.exists(
							platform,
							(platform) => platform.document.organizationCreation === "anyone",
						)
						if (
							!anyone &&
							!(yield* admins
								.check({ id: account.userId })
								.pipe(Effect.mapError(unavailable)))
						)
							return yield* OrganizationApi.OrganizationCreationDisabled.make(
								{},
							)
						return yield* organization
							.create({ name: payload.name, owner: { id: account.userId } })
							.pipe(Effect.mapError(unavailable))
					}),
				)
				.handle("leaveOrganization", ({ params }) =>
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
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
								),
							)
						yield* record(
							account.userId,
							params.organizationId,
							"member.left",
							{},
						)
					}),
				)
				.handle("listMyInvitations", () =>
					Effect.flatMap(Account, (account) =>
						organization.invitationsFor(account.userId),
					).pipe(
						Effect.map((items) => ({ items })),
						Effect.mapError(unavailable),
					),
				)
				.handle("acceptInvitation", ({ params }) =>
					Effect.gen(function* () {
						const invitation = yield* answer(params.invitationId, "accepted")
						return yield* organization
							.get(invitation.organizationId)
							.pipe(
								Effect.flatMap(Effect.fromOption),
								Effect.mapError(unavailable),
							)
					}),
				)
				.handle("declineInvitation", ({ params }) =>
					answer(params.invitationId, "declined"),
				)
		}),
)

export const layer = Layer.merge(organizationGroup, organizationsGroup)
