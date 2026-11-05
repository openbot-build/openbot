import type { Chat } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect, Option } from "effect"

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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/conversation-contract/capabilities/Grants") {}

export { type Grant }
