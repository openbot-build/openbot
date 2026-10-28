import type { Chat } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	String as Str,
} from "effect"
import { BotRecords } from "../bots/BotRecords.ts"
import { decidingGrant } from "./Policy.ts"

type Grant = BotsApi.Grant

/** Stored decisions about the capabilities of Bots. */
export class Grants extends Context.Service<
	Grants,
	{
		/** Read a saved Grant, including one that was used or revoked. */
		readonly find: (
			organizationId: string,
			id: BotsApi.GrantId,
		) => Effect.Effect<Option.Option<Grant>, BotsApi.BotStorageUnavailable>
		/**
		 * The Grant that decides a request, if there is one. A deny Grant wins over an allow Grant.
		 * Chat Grants only count in their own Chat.
		 */
		readonly match: (input: {
			readonly organizationId: string
			readonly bot: string
			readonly capability: BotsApi.Capability
			readonly chat: Chat.Id
		}) => Effect.Effect<Option.Option<Grant>, BotsApi.BotStorageUnavailable>
		/**
		 * Takes a Grant for one call. A `once` Grant is marked as used, so it does not count
		 * again. False when a `once` Grant is no longer active, for example because another
		 * call took it first or a person revoked it.
		 */
		readonly use: (
			organizationId: string,
			grant: Grant,
		) => Effect.Effect<boolean, BotsApi.BotStorageUnavailable>
		/** `used` keeps a `once` Grant only as a record, because its one call already has it. */
		readonly create: (
			organizationId: string,
			input: Omit<Grant, "id" | "status" | "createdAt">,
			used?: boolean,
		) => Effect.Effect<Grant, BotsApi.BotStorageUnavailable>
		readonly list: (
			organizationId: string,
			bot: string,
			status?: Grant["status"],
		) => Effect.Effect<ReadonlyArray<Grant>, BotsApi.BotStorageUnavailable>
		/** Revokes a Grant and every Grant that came from it. Returns the revoked Grants. */
		readonly revoke: (
			organizationId: string,
			bot: string,
			id: string,
		) => Effect.Effect<
			ReadonlyArray<Grant>,
			BotsApi.GrantNotFound | BotsApi.BotStorageUnavailable
		>
	}
>()("@openbot-build/openbot/capabilities/Grants") {}

export const make: Effect.Effect<
	typeof Grants.Service,
	never,
	BotRecords | Crypto.Crypto
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const newId = crypto
		.randomUUIDv7()
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
