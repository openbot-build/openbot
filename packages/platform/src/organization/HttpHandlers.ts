import {
	type Caller,
	Identity,
	OrganizationApi,
	Permissions,
	PlatformApi,
} from "@openbot-build/platform-api"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import {
	inOrganization,
	organizationKey,
	userKey,
} from "../authorization/Policy.ts"
import { Organization, type OrganizationUnavailable } from "./Organization.ts"

const superAdministrator = "super_administrator"
const unavailable = () =>
	OrganizationApi.OrganizationStorageUnavailable.make({})

export const layer = HttpApiBuilder.group(
	PlatformApi,
	"organization",
	(handlers) =>
		Effect.gen(function* () {
			const organization = yield* Organization
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

			return handlers
				.handle("getOrganization", () =>
					Effect.flatMap(Identity, (caller) =>
						organization.get(caller.organizationId),
					).pipe(Effect.mapError(unavailable)),
				)
				.handle("updateOrganization", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						// New members must not join as Super Administrators unless one says so.
						if (payload.defaultRoles?.includes(superAdministrator) === true)
							yield* requireSuperAdministrator(
								caller,
								"organization.write",
								organizationKey(caller.organizationId),
							)
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
				.handle("listRoles", () => Effect.succeed(Permissions.roles))
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
