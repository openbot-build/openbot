import { randomBytes, randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Clock, Context, Effect, Layer } from "effect"
import {
	DeveloperRepository,
	type InvitationRecord,
} from "./DeveloperRepository.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { ownerKey } from "./Repository.ts"

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
			identity: { readonly tenantId: string; readonly userId: string },
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
>()("@openbot-build/platform/apps/DeveloperMembers") {}

export const make: Effect.Effect<
	typeof DeveloperMembers.Service,
	never,
	DeveloperRepository | DeveloperAccess
> = Effect.gen(function* () {
	const records = yield* DeveloperRepository
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
	const activeInvitation = Effect.fn("DeveloperMembers.activeInvitation")(
		function* (id: string) {
			const record = yield* records.invitations.get(id)
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
		list: (owner, proofId) =>
			Effect.gen(function* () {
				yield* admin(owner, proofId)
				return {
					members: (yield* records.members.list({ scope: proofId })).map(
						(record) => record.value,
					),
					invitations: (yield* records.invitations.list({
						scope: proofId,
					})).map((record) => record.value),
				}
			}),
		invite: (owner, proofId, role) =>
			records.transaction(
				"proof:" + proofId,
				Effect.gen(function* () {
					const proof = yield* admin(owner, proofId)
					const value: Api.Invitation = {
						id: yield* Effect.sync(() => randomBytes(32).toString("base64url")),
						proofId,
						scope: proof.value.scope,
						role,
						expiresAt: (yield* Clock.currentTimeMillis) + 7 * 86400000,
						status: "Pending",
					}
					yield* records.invitations.put(value.id, owner, proofId, {
						owner,
						acceptedBy: null,
						value,
					})
					return value
				}),
			),
		preview: (id) => Effect.map(activeInvitation(id), (record) => record.value),
		accept: (identity, id) =>
			records.transaction(
				"invitation:" + id,
				Effect.gen(function* () {
					const record = yield* activeInvitation(id)
					const owner = ownerKey(identity)
					return yield* records.transaction(
						"membership:" + JSON.stringify([record.value.proofId, owner]),
						Effect.gen(function* () {
							if (
								(yield* records.members.list({
									owner,
									scope: record.value.proofId,
								})).length > 0
							)
								return yield* conflict("AlreadyMember")
							const member: Api.Member = {
								id: yield* Effect.sync(randomUUID),
								proofId: record.value.proofId,
								identity,
								role: record.value.role,
							}
							const accepted: InvitationRecord = {
								...record,
								acceptedBy: owner,
								value: { ...record.value, status: "Accepted" },
							}
							yield* records.members.put(member.id, owner, member.proofId, {
								owner,
								value: member,
							})
							yield* records.invitations.put(
								id,
								record.owner,
								record.value.proofId,
								accepted,
							)
							return {
								proofId: member.proofId,
								memberId: member.id,
								scope: record.value.scope,
								role: member.role,
							}
						}),
					)
				}),
			),
		revoke: (owner, id) =>
			records.transaction(
				"invitation:" + id,
				Effect.gen(function* () {
					const record = yield* records.invitations.get(id)
					yield* admin(owner, record.value.proofId)
					if (record.value.status === "Accepted")
						return yield* conflict("InvitationAlreadyAccepted")
					const value: Api.Invitation = { ...record.value, status: "Revoked" }
					yield* records.invitations.put(
						id,
						record.owner,
						record.value.proofId,
						{ ...record, value },
					)
					return value
				}),
			),
		change: (owner, id, role) =>
			records.transaction(
				"member:" + id,
				Effect.gen(function* () {
					const record = yield* records.members.get(id)
					const proof = yield* admin(owner, record.value.proofId)
					const value: Api.Member = { ...record.value, role }
					yield* records.members.put(id, record.owner, proof.value.id, {
						...record,
						value,
					})
					return value
				}),
			),
		remove: (owner, id) =>
			records.transaction(
				"member:" + id,
				Effect.gen(function* () {
					const record = yield* records.members.get(id)
					if (record.owner !== owner) yield* admin(owner, record.value.proofId)
					yield* records.members.remove(id)
					const noticeId = yield* Effect.sync(randomUUID)
					yield* records.notices.put(noticeId, record.owner, "", {
						owner: record.owner,
						value: {
							id: noticeId,
							cardUrl: null,
							kind: "AccessChanged",
							issue: null,
							reason: "MembershipRemoved",
							reportId: null,
							createdAt: yield* Clock.currentTimeMillis,
							readAt: null,
						},
					})
				}),
			),
	})
})
export const layer = Layer.effect(DeveloperMembers, make)
