import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"

/** Where one record is. `owner` and `scope` are the keys that lists filter by. */
export interface Keys<Status extends string = string> {
	readonly organizationId: string
	readonly id: string
	readonly owner: string
	readonly scope: string
	readonly status: Status
}

export interface Filter<Status extends string = string> {
	readonly owner?: string
	readonly scope?: string
	readonly status?: Status
}

/** Typed JSON records of one kind. */
export interface Collection<A, Status extends string = string> {
	readonly find: (
		organizationId: string,
		id: string,
	) => Effect.Effect<Option.Option<A>, BotsApi.BotStorageUnavailable>
	readonly list: (
		organizationId: string,
		filter?: Filter<Status>,
	) => Effect.Effect<ReadonlyArray<A>, BotsApi.BotStorageUnavailable>
	readonly put: (
		keys: Keys<Status>,
		value: A,
	) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
	readonly remove: (
		organizationId: string,
		id: string,
	) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
}

export class BotRecords extends Context.Service<
	BotRecords,
	{
		/** `status` is the set of values that the status key can have. */
		readonly collection: <
			S extends Schema.Codec<any, any>,
			Status extends string = string,
		>(
			kind: string,
			schema: S,
			status?: Schema.Schema<Status>,
		) => Collection<S["Type"], Status>
		/**
		 * Runs the operation in one transaction that holds a lock on `key`.
		 * Read-change-write steps on the same key never run at the same time.
		 */
		readonly transaction: <A, E, R>(
			key: string,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | BotsApi.BotStorageUnavailable, R>
		/**
		 * Takes the lock on `key` as well, and waits for it. The lock lasts until
		 * the transaction ends, so use it only inside `transaction`.
		 */
		readonly lock: (
			key: string,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/conversation-contract/bots/BotRecords") {}
