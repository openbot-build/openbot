import { randomBytes, randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
	developerInvitations,
	developerMembers,
	developerProofs,
} from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { ownerKey } from "./StoredConnections.ts"

export class DeveloperMembers extends Context.Service<
	DeveloperMembers,
	{
		readonly list: (
			owner: string,
			proofId: string,
		) => Effect.Effect<
			{
				readonly members: ReadonlyArray<Api.Member>
				readonly invitations: ReadonlyArray<Api.Invitation>
			},
			Api.Failure
		>
		readonly invite: (
			owner: string,
			proofId: string,
			role: Api.MemberRole,
		) => Effect.Effect<Api.Invitation, Api.Failure>
		readonly preview: (id: string) => Effect.Effect<Api.Invitation, Api.Failure>
		readonly accept: (
			identity: { readonly organizationId: string; readonly userId: string },
			id: string,
		) => Effect.Effect<Api.Grant, Api.Failure>
		readonly revoke: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Invitation, Api.Failure>
		readonly change: (
			owner: string,
			id: string,
			role: Api.MemberRole,
		) => Effect.Effect<Api.Member, Api.Failure>
		readonly remove: (
			owner: string,
			id: string,
		) => Effect.Effect<void, Api.Failure>
	}
>()("@openbot-build/openbot/apps/DeveloperMembers") {}

const InvitationRow = Schema.Struct({
	...Api.Invitation.fields,
	scope: Rows.Json(Api.ManagementScope),
})
const MemberRow = Schema.Struct({
	id: Schema.String,
	proofId: Schema.String,
	role: Api.MemberRole,
})

export const make: Effect.Effect<
	typeof DeveloperMembers.Service,
	never,
	PgClient.PgClient | DeveloperAccess
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const access = yield* DeveloperAccess
	const conflict = (reason: string) => Api.DeveloperConflict.make({ reason })
	const admin = Effect.fn("DeveloperMembers.admin")(function* (
		owner: string,
		id: string,
	) {
		const proof = yield* access.ownProof(owner, id)
		if (
			!(yield* access.grants(owner)).some(
				(grant) => grant.proofId === id && grant.role === "administrator",
			)
		)
			return yield* Api.DeveloperForbidden.make({})
		return proof
	})
	const invitationWhere = (id: string) =>
		and(
			eq(developerInvitations.namespace, namespace),
			eq(developerInvitations.id, id),
		)
	/** Read an invitation with the scope of its proof. With `lock`, keep the row locked. */
	const readInvitation = Effect.fn("DeveloperMembers.readInvitation")(
		function* (id: string, lock = false) {
			const query = db
				.select({
					invitation: developerInvitations,
					scope: developerProofs.scope,
				})
				.from(developerInvitations)
				.innerJoin(
					developerProofs,
					and(
						eq(developerProofs.namespace, developerInvitations.namespace),
						eq(developerProofs.id, developerInvitations.proofId),
					),
				)
				.where(invitationWhere(id))
			const row = (yield* Rows.stored(
				lock ? query.for("update", { of: developerInvitations }) : query,
			))[0]
			if (row === undefined) return yield* Api.DeveloperNotFound.make({})
			const value = yield* Schema.decodeUnknownEffect(InvitationRow)({
				...row.invitation,
				scope: row.scope,
			}).pipe(Effect.mapError(Rows.unavailable))
			return { owner: row.invitation.owner, value }
		},
	)
	const setInvitation = (
		id: string,
		change: {
			readonly status: Api.Invitation["status"]
			readonly acceptedBy?: string
		},
	) =>
		Rows.stored(
			db.update(developerInvitations).set(change).where(invitationWhere(id)),
		)
	const memberWhere = (id: string) =>
		and(eq(developerMembers.namespace, namespace), eq(developerMembers.id, id))
	const toMember = (row: typeof developerMembers.$inferSelect) =>
		Effect.gen(function* () {
			const member = yield* Schema.decodeUnknownEffect(MemberRow)(row).pipe(
				Effect.mapError(Rows.unavailable),
			)
			return {
				...member,
				identity: yield* Rows.identityOf(row.owner),
			} satisfies Api.Member
		})
	/** Read a member and lock its row until the transaction ends. */
	const lockMember = Effect.fn("DeveloperMembers.lockMember")(function* (
		id: string,
	) {
		const row = (yield* Rows.stored(
			db.select().from(developerMembers).where(memberWhere(id)).for("update"),
		))[0]
		if (row === undefined) return yield* Api.DeveloperNotFound.make({})
		return { owner: row.owner, value: yield* toMember(row) }
	})
	const activeInvitation = Effect.fn("DeveloperMembers.activeInvitation")(
		function* (id: string, lock = false) {
			const record = yield* readInvitation(id, lock)
			if (record.value.status !== "Pending")
				return yield* conflict("InvitationInactive")
			if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* conflict("InvitationExpired")
			yield* admin(record.owner, record.value.proofId).pipe(
				Effect.catchTags({
					DeveloperForbidden: () =>
						Effect.fail(conflict("InvitationSourceInactive")),
					DeveloperNotFound: () =>
						Effect.fail(conflict("InvitationSourceInactive")),
				}),
			)
			return record
		},
	)
	return DeveloperMembers.of({
		list: Effect.fn("DeveloperMembers.list")(function* (owner, proofId) {
			const proof = yield* admin(owner, proofId)
			const members = yield* Rows.stored(
				db
					.select()
					.from(developerMembers)
					.where(
						and(
							eq(developerMembers.namespace, namespace),
							eq(developerMembers.proofId, proofId),
						),
					)
					.orderBy(developerMembers.id),
			)
			const invitations = yield* Rows.stored(
				db
					.select()
					.from(developerInvitations)
					.where(
						and(
							eq(developerInvitations.namespace, namespace),
							eq(developerInvitations.proofId, proofId),
						),
					)
					.orderBy(developerInvitations.id),
			)
			return {
				members: yield* Effect.forEach(members, toMember),
				invitations: yield* Effect.forEach(invitations, (row) =>
					Schema.decodeUnknownEffect(Api.Invitation)({
						...row,
						scope: proof.value.scope,
					}).pipe(Effect.mapError(Rows.unavailable)),
				),
			}
		}),
		invite: Effect.fn("DeveloperMembers.invite")(
			function* (owner, proofId, role) {
				const proof = yield* admin(owner, proofId)
				const value: Api.Invitation = {
					id: yield* Effect.sync(() => randomBytes(32).toString("base64url")),
					proofId,
					scope: proof.value.scope,
					role,
					expiresAt: (yield* Clock.currentTimeMillis) + 7 * 86400000,
					status: "Pending",
				}
				yield* Rows.stored(
					db.insert(developerInvitations).values({
						namespace,
						id: value.id,
						proofId,
						owner,
						role,
						expiresAt: value.expiresAt,
						status: value.status,
					}),
				)
				return value
			},
		),
		preview: (id) => Effect.map(activeInvitation(id), (record) => record.value),
		accept: (identity, id) =>
			inTransaction(
				Effect.gen(function* () {
					const record = yield* activeInvitation(id, true)
					const owner = ownerKey(identity)
					const member: Api.Member = {
						id: yield* Effect.sync(randomUUID),
						proofId: record.value.proofId,
						identity,
						role: record.value.role,
					}
					// The table allows one membership for each proof and account.
					const inserted = yield* Rows.stored(
						db
							.insert(developerMembers)
							.values({
								namespace,
								id: member.id,
								proofId: member.proofId,
								owner,
								role: member.role,
							})
							.onConflictDoNothing()
							.returning({ id: developerMembers.id }),
					)
					if (inserted.length === 0) return yield* conflict("AlreadyMember")
					yield* setInvitation(id, { status: "Accepted", acceptedBy: owner })
					return {
						proofId: member.proofId,
						memberId: member.id,
						scope: record.value.scope,
						role: member.role,
					}
				}),
			),
		revoke: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const record = yield* readInvitation(id, true)
					yield* admin(owner, record.value.proofId)
					if (record.value.status === "Accepted")
						return yield* conflict("InvitationAlreadyAccepted")
					yield* setInvitation(id, { status: "Revoked" })
					return { ...record.value, status: "Revoked" } satisfies Api.Invitation
				}),
			),
		change: (owner, id, role) =>
			inTransaction(
				Effect.gen(function* () {
					const record = yield* lockMember(id)
					yield* admin(owner, record.value.proofId)
					yield* Rows.stored(
						db.update(developerMembers).set({ role }).where(memberWhere(id)),
					)
					return { ...record.value, role } satisfies Api.Member
				}),
			),
		remove: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const record = yield* lockMember(id)
					if (record.owner !== owner) yield* admin(owner, record.value.proofId)
					yield* Rows.stored(db.delete(developerMembers).where(memberWhere(id)))
					yield* Rows.postNotice(db, namespace, record.owner, {
						id: yield* Effect.sync(randomUUID),
						cardUrl: null,
						kind: "AccessChanged",
						issue: null,
						reason: "MembershipRemoved",
						reportId: null,
						createdAt: yield* Clock.currentTimeMillis,
						readAt: null,
					})
				}),
			),
	})
})
export const layer = Layer.effect(DeveloperMembers, make)
