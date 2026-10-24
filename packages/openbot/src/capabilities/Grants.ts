import { randomUUID } from "node:crypto"
import type { Chat } from "@openbot-build/core"
import { BotsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { BotRecords } from "../bots/BotRecords.ts"
import { decidingGrant } from "./Policy.ts"

type Grant = BotsApi.Grant

/** Stored decisions about the capabilities of Bots. */
export class Grants extends Context.Service<
	Grants,
	{
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
		/** Marks a `once` Grant as used, so it does not count again. */
		readonly use: (
			organizationId: string,
			grant: Grant,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
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
			BotsApi.BotNotFound | BotsApi.BotStorageUnavailable
		>
	}
>()("@openbot-build/openbot/capabilities/Grants") {}

export const make: Effect.Effect<typeof Grants.Service, never, BotRecords> =
	Effect.gen(function* () {
		const records = yield* BotRecords
		const grants = records.collection(
			"grant",
			BotsApi.Grant,
			BotsApi.GrantStatus,
		)
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
				const revoked = yield* put(organizationId, {
					...grant,
					status: "revoked",
				})
				const children = yield* grants.list(organizationId, {
					scope: grant.id,
					status: "active",
				})
				const below = yield* Effect.forEach(children, (child) =>
					revokeTree(organizationId, child),
				)
				return [revoked, ...below.flat()]
			})
		return Grants.of({
			match: (input) =>
				grants
					.list(input.organizationId, {
						owner: input.bot,
						status: "active",
					})
					.pipe(
						Effect.map((list) =>
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
					? put(organizationId, { ...grant, status: "used" }).pipe(
							Effect.asVoid,
						)
					: Effect.void,
			create: (organizationId, input, used) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...input,
						id: "grt_" + randomUUID().replaceAll("-", ""),
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
							return yield* BotsApi.BotNotFound.make({ bot: id })
						if (grant.value.status === "revoked") return []
						return yield* revokeTree(organizationId, grant.value)
					}),
				),
		})
	})
export const layer = Layer.effect(Grants, make)
