import { Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Effect,
	Layer,
	Option,
	String as Str,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import { decidingGrant } from "../conversation-contract/capabilities/Policy.ts"
import {
	type Grant,
	Grants,
} from "../conversation-contract/capabilities/Grants.ts"
export { Grants } from "../conversation-contract/capabilities/Grants.ts"

export const make: Effect.Effect<
	typeof Grants.Service,
	never,
	BotRecords | SecureRandom.SecureRandom
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* SecureRandom.SecureRandom
	const newId = crypto
		.uuidV7()
		.pipe(Effect.orDie, Effect.map(Str.replaceAll("-", "")))
	const grants = records.collection("grant", BotsApi.Grant, BotsApi.GrantStatus)
	const put = (organizationId: string, grant: Grant) =>
		grants
			.put(
				{
					organizationId,
					id: grant.id,
					owner: grant.bot,
					scope: grant.parent ?? "",
					status: grant.status,
				},
				grant,
			)
			.pipe(Effect.as(grant))
	const revokeTree = (
		organizationId: string,
		grant: Grant,
	): Effect.Effect<ReadonlyArray<Grant>, BotsApi.BotStorageUnavailable> =>
		Effect.gen(function* () {
			// Each child takes the same lock as use before it reads its state.
			yield* records.lock("grant:" + organizationId + ":" + grant.id)
			const current = yield* grants.find(organizationId, grant.id)
			if (Option.isNone(current) || current.value.status === "revoked")
				return []
			const revoked = yield* put(organizationId, {
				...current.value,
				status: "revoked",
			})
			const children = yield* grants.list(organizationId, {
				scope: grant.id,
			})
			// A used Grant may still serve its saved call after a restart.
			const below = yield* Effect.forEach(
				Arr.filter(children, (child) => child.status !== "revoked"),
				(child) => revokeTree(organizationId, child),
			)
			return [revoked, ...Arr.flatten(below)]
		})
	return Grants.of({
		find: grants.find,
		match: (input) =>
			grants
				.list(input.organizationId, {
					owner: input.bot,
					status: "active",
				})
				.pipe(
					Effect.flatMap((list) =>
						decidingGrant({
							grants: list,
							bot: input.bot,
							capability: input.capability,
							chat: input.chat,
						}),
					),
				),
		use: (organizationId, grant) =>
			grant.scope === "once"
				? // The lock is the one that `revoke` takes, so two calls never take one Grant.
					records.transaction(
						"grant:" + organizationId + ":" + grant.id,
						Effect.gen(function* () {
							const current = yield* grants.find(organizationId, grant.id)
							if (Option.isNone(current) || current.value.status !== "active")
								return false
							yield* put(organizationId, { ...current.value, status: "used" })
							return true
						}),
					)
				: Effect.succeed(true),
		create: (organizationId, input, used) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				return yield* put(organizationId, {
					...input,
					id: BotsApi.GrantId.make("grt_" + (yield* newId)),
					status: used === true && input.scope === "once" ? "used" : "active",
					createdAt: now,
				})
			}),
		list: (organizationId, bot, status) =>
			grants.list(organizationId, {
				owner: bot,
				...(status === undefined ? {} : { status }),
			}),
		revoke: (organizationId, bot, id) =>
			records.transaction(
				"grant:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const grant = yield* grants.find(organizationId, id)
					if (Option.isNone(grant) || grant.value.bot !== bot)
						return yield* BotsApi.GrantNotFound.make({
							grant: BotsApi.GrantId.make(id),
						})
					if (grant.value.status === "revoked") return []
					return yield* revokeTree(organizationId, grant.value)
				}),
			),
	})
})

export const layer = Layer.effect(Grants, make)
