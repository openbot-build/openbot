import {
	Account,
	type Caller,
	Identity,
	OrganizationApi,
	Permissions,
	OpenBotApi,
	Settings as SettingsApi,
} from "@openbot-build/api"
import { Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { can } from "../authorization/Check.ts"
import {
	expand,
	inOrganization,
	organizationKey,
	userKey,
} from "../authorization/Policy.ts"
import { Roles } from "../authorization/Roles.ts"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"
import { PlatformAdmins } from "../platform/PlatformAdmins.ts"
import { Organization, type OrganizationUnavailable } from "./Organization.ts"

const superAdministrator = "super_administrator"
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
			/** Fails unless the caller is a Super Administrator. */
			const requireSuperAdministrator = (
				caller: Caller,
				permission: Permissions.PermissionGroupId,
				resource: string,
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
					return yield* Permissions.PermissionDenied.make({
						permission,
						resource,
					})
				})
			/**
			 * Only a Super Administrator can change or remove a Super Administrator,
			 * give someone the role, or give extra `allow` policies.
			 * Other administrators can only take permissions away with `deny` policies,
			 * so they cannot give anyone more than a role gives.
			 */
			const guardSuperAdministrator = (
				caller: Caller,
				target: OrganizationApi.Member,
				patch: OrganizationApi.UpdateMemberRequest,
			) =>
				target.roles.includes(superAdministrator) ||
				(patch.roles?.includes(superAdministrator) ?? false) ||
				(patch.policies?.some((policy) => policy.effect === "allow") ?? false)
					? requireSuperAdministrator(
							caller,
							"members.write",
							userKey({
								organizationId: caller.organizationId,
								userId: target.userId,
							}),
						)
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
			 * A role may only name resources in the organization, and its `allow`
			 * policies cannot give more than the caller has. Otherwise anyone who
			 * can write roles could give themselves every permission.
			 */
			const checkRolePolicies = (
				caller: Caller,
				policies: ReadonlyArray<Permissions.Policy>,
			) =>
				Effect.gen(function* () {
					if (
						!inOrganization({ policies, organizationId: caller.organizationId })
					)
						return yield* OrganizationApi.PolicyInvalid.make({
							message:
								"A role can only name resources in your own organization.",
						})
					const subject = {
						organizationId: caller.organizationId,
						userId: caller.userId,
					}
					for (const policy of policies) {
						if (policy.effect !== "allow") continue
						for (const permission of policy.permissionGroups)
							for (const resource of policy.resources) {
								const key = expand({ pattern: resource, subject })
								if (
									!(yield* can({ caller, permission, key }).pipe(
										Effect.provideContext(services),
									))
								)
									return yield* Permissions.PermissionDenied.make({
										permission,
										resource: key,
									})
							}
					}
				})

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
									"organization.write",
									organizationKey(caller.organizationId),
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
						if (
							payload.policies !== undefined &&
							!inOrganization({
								policies: payload.policies,
								organizationId: caller.organizationId,
							})
						)
							return yield* OrganizationApi.PolicyInvalid.make({
								message:
									"A policy can only name resources in your own organization.",
							})
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
									policies: member.policies.length,
								},
								after: {
									status: updated.status,
									roles: [...updated.roles],
									policies: updated.policies.length,
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
				.handle("listPermissionGroups", () =>
					Effect.succeed(Permissions.permissionGroups),
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
						yield* checkRolePolicies(caller, payload.policies)
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
						if (payload.policies !== undefined)
							yield* checkRolePolicies(caller, payload.policies)
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
		}),
)

export const layer = Layer.merge(organizationGroup, organizationsGroup)
