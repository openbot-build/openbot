import {
	Authorization,
	Computers as Domain,
	Execution,
	executionCallers,
	type Caller,
	type ExecutionIdentity,
	type BotId,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Effect, Option } from "effect"
import * as Check from "../authorization/Check.ts"
import { Bots } from "../bots/Bots.ts"
import * as Db from "../database/Database.ts"
import { computerAccess, computers } from "../database/Schema.ts"

/** Queries and rights do not depend on a driver or a physical connection. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const checks = yield* Check.make
	const bots = yield* Bots
	const stored = <A, E>(effect: Effect.Effect<A, E>) =>
		effect.pipe(Effect.mapError((cause) => Domain.StorageError.make({ cause })))
	const get = (caller: Caller, id: string, need: Domain.Need) =>
		Effect.gen(function* () {
			const rows = yield* stored(
				db
					.select()
					.from(computers)
					.where(
						and(
							eq(computers.organizationId, caller.organizationId),
							eq(computers.id, id),
						),
					),
			)
			const row = rows[0]
			if (row === undefined) return yield* Domain.ComputerNotFound.make({ id })
			yield* checks.guard(
				caller,
				{
					action: need,
					resource: Authorization.Computer.make({
						organizationId: row.organizationId,
						ownerUserId: row.ownerUserId,
						id: row.id,
					}),
				},
				{ hide: () => Domain.ComputerNotFound.make({ id }) },
			)
			return row
		})
	const holds = (organizationId: string, bot: BotId, id: string) =>
		Effect.gen(function* () {
			const rows = yield* stored(
				db
					.select({ bot: computerAccess.bot })
					.from(computerAccess)
					.where(
						and(
							eq(computerAccess.organizationId, organizationId),
							eq(computerAccess.computerId, id),
							eq(computerAccess.bot, bot),
						),
					),
			)
			if (rows.length === 0) return false
			const found = yield* stored(bots.find(organizationId, bot))
			return Option.isSome(found) && !found.value.archived
		})
	const execution = (
		identity: ExecutionIdentity,
		id: string,
		need: Domain.Need,
	) =>
		Effect.gen(function* () {
			for (const caller of executionCallers(identity)) {
				if (caller.organizationId !== identity.owner.organizationId)
					return yield* Execution.Forbidden.make({})
				yield* get(caller, id, need)
			}
			if (
				identity.botId !== undefined &&
				!(yield* holds(identity.owner.organizationId, identity.botId, id))
			)
				return yield* Execution.Forbidden.make({})
		})
	return { get, holds, execution }
})
