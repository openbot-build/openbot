import { Item, ToolStep } from "@openbot-build/core"
import { BotRecords } from "../bots/BotRecords.ts"
import { Requests } from "./Requests.ts"
import { Bots as BotDomain, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Crypto, Effect, Option, Schema } from "effect"
import * as Hex from "effect/encoding/Hex"
import * as StoredChats from "../chats/StoredChats.ts"
import * as PolicyOrigin from "./PolicyOrigin.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import { grantUses } from "../database/ExecutionSchema.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import { Grants } from "./Grants.ts"

class GrantTaken extends Schema.TaggedError<
	GrantTaken,
	{ readonly brand: unique symbol }
>()("GrantUse.GrantTaken", {}) {}

/** One-use Grants belong to a saved call, across owners and the move to a child tool. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const access = yield* TurnAccess
	const grants = yield* Grants
	const requests = yield* Requests
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const { read: source } = yield* PolicyOrigin.make
	const check = Effect.fn("GrantUse.check")(function* (
		fence: Fence,
		site: Execution.CallSite,
		capability: BotDomain.Capability,
		control?: PolicyOrigin.Control,
	) {
		const origin = yield* source(fence, site, control)
		const organizationId = origin.identity.owner.organizationId
		const callKey = Hex.encode(
			yield* crypto.digest(
				"SHA-256",
				new TextEncoder().encode(
					yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Array(Schema.String)),
					)(origin.operation),
				),
			),
		)
		const commandKey = Execution.CommandKey.make(
			`grant:${origin.parent}:${callKey}`,
		)
		const command = {
			actor: origin.identity.actor,
			body: {
				turnExecutionId: origin.parent,
				position: origin.position,
				operation: origin.operation,
				capability,
			},
		}
		const find = db
			.select()
			.from(grantUses)
			.where(
				and(
					eq(grantUses.namespace, fence.namespace),
					eq(grantUses.turnExecutionId, origin.parent),
					eq(grantUses.callKey, callKey),
				),
			)
			.pipe(Effect.map(Arr.head))
		const matched = () =>
			grants.match({
				organizationId,
				bot: origin.bot,
				chat: origin.position.chat,
				capability,
			})
		const kept = Effect.gen(function* () {
			const row = yield* find
			if (Option.isNone(row)) return Option.none<BotDomain.Grant>()
			if (
				row.value.organizationId !== organizationId ||
				Option.isNone(
					yield* store.receipt(fence.namespace, commandKey, command),
				)
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			const grant = yield* grants.find(
				organizationId,
				BotDomain.GrantId.make(row.value.grantId),
			)
			if (
				Option.isNone(grant) ||
				grant.value.bot !== origin.bot ||
				grant.value.scope !== "once" ||
				grant.value.status === "active"
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return grant.value.status === "revoked"
				? Option.some({
						...grant.value,
						effect: "deny" as const,
						reason: "The Grant for this call was revoked.",
					})
				: grant
		})
		// Only a host notice can carry an approval into a later Turn. A model's call ID is no proof.
		const approved = Effect.gen(function* () {
			if (control !== undefined || Option.isNone(origin.call))
				return Option.none<BotDomain.Grant>()
			const call = origin.call.value
			const params = yield* Schema.decodeUnknownEffect(Schema.Json)(call.params)
			const items = yield* StoredChats.persistence(db, fence.namespace).items(
				origin.position.chat,
				{ turn: origin.position.turn },
			)
			for (const raw of items) {
				const item = yield* Schema.decodeUnknownEffect(Item.Record)(raw)
				if (
					item.origin?.notice?.kind !== "request" ||
					item.origin.notice.ref === undefined
				)
					continue
				const decision = ToolStep.decisionFor(item.content, call.id)
				if (!Option.exists(decision, (value) => value.approved)) continue
				const found = yield* requests.find(
					organizationId,
					item.origin.notice.ref,
				)
				if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
				const saved = found.value
				if (
					saved.request.status !== "allowed" ||
					saved.request.bot !== origin.bot ||
					saved.request.chat !== origin.position.chat ||
					saved.chain.userId !== origin.identity.actor.userId ||
					saved.chain.tokenId !== origin.identity.actor.tokenId ||
					saved.call?.name !== call.name ||
					!Schema.toEquivalence(Schema.Json)(saved.call.params, params) ||
					!Schema.toEquivalence(BotDomain.Capability)(
						saved.request.capability,
						capability,
					) ||
					saved.approvalGrant === undefined
				)
					return yield* Execution.Forbidden.make({})
				const grant = yield* grants.find(organizationId, saved.approvalGrant)
				if (Option.isNone(grant) || grant.value.bot !== origin.bot)
					return yield* Execution.Forbidden.make({})
				return grant.value.status === "revoked"
					? Option.some({
							...grant.value,
							effect: "deny" as const,
							reason: "The Grant for this call was revoked.",
						})
					: grant
			}
			return Option.none<BotDomain.Grant>()
		})
		const previous = yield* kept
		let current = yield* matched()
		// A new deny still stops a call that already has a one-use Grant.
		if (Option.exists(current, (grant) => grant.effect === "deny"))
			return current
		if (Option.isSome(previous)) return previous
		const approval = yield* approved
		if (Option.isSome(approval)) current = approval
		if (Option.exists(current, (grant) => grant.effect === "deny"))
			return current
		if (Option.isNone(current) || current.value.scope !== "once") return current
		const grant = current.value
		yield* store
			.accept(fence.namespace, commandKey, command, () =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, origin.position.chat)
					yield* access.authorize(
						control === undefined
							? fence
							: { namespace: fence.namespace, id: origin.parent },
						origin.identity.actor,
						control === undefined ? "advance" : "replay",
					)
					return yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Checkpoint",
									resource: { kind: "Grant", id: grant.id },
									revision: 0,
								},
							],
						},
						Effect.gen(function* () {
							const checked = yield* source(fence, site, control)
							if (
								checked.parent !== origin.parent ||
								!Schema.toEquivalence(Schema.Array(Schema.String))(
									checked.operation,
									origin.operation,
								)
							)
								return yield* Execution.Conflict.make({ id: fence.id })
							if (Option.isSome(approval)) {
								yield* records.lock(`grant:${organizationId}:${grant.id}`)
								const claims = yield* db
									.select()
									.from(grantUses)
									.where(
										and(
											eq(grantUses.organizationId, organizationId),
											eq(grantUses.grantId, grant.id),
										),
									)
								if (
									Arr.some(
										claims,
										(claim) =>
											claim.namespace !== fence.namespace ||
											claim.turnExecutionId !== origin.parent ||
											claim.callKey !== callKey,
									)
								)
									return yield* Execution.Forbidden.make({})
							}
							const policy = yield* matched()
							if (Option.exists(policy, (value) => value.effect === "deny"))
								return yield* GrantTaken.make({})
							const selected = Option.isSome(approval)
								? yield* approved
								: policy
							if (
								Option.isNone(selected) ||
								selected.value.id !== grant.id ||
								selected.value.effect !== "allow" ||
								(Option.isSome(approval)
									? selected.value.status !== "used"
									: !(yield* grants.use(organizationId, selected.value)))
							)
								return yield* GrantTaken.make({})
							yield* db.insert(grantUses).values({
								namespace: fence.namespace,
								turnExecutionId: origin.parent,
								callKey,
								organizationId,
								grantId: grant.id,
							})
							return { executionId: fence.id, start: false }
						}),
					)
				}),
			)
			.pipe(Effect.catchTag("GrantUse.GrantTaken", () => Effect.void))
		const policy = yield* matched()
		return Option.exists(policy, (value) => value.effect === "deny")
			? policy
			: yield* kept
	}, storage)
	return { check }
})
