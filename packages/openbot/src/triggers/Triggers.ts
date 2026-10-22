import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
	type AgentsApi,
	type Caller,
	Permissions,
	TriggersApi,
} from "@openbot-build/api"
import { and, eq, isNull, lte, or } from "drizzle-orm"
import { Clock, Context, Cron, Effect, Layer, Option, Result } from "effect"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { can } from "../authorization/Check.ts"
import { triggerKey, triggerPlace } from "../authorization/Policy.ts"
import { triggers } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"

type Trigger = TriggersApi.Trigger
type Row = typeof triggers.$inferSelect

/** The next time after `now` that a schedule fires, or why it is not valid. */
export const nextRun = (input: {
	readonly schedule: TriggersApi.Schedule
	readonly now: number
}) =>
	Cron.parse(input.schedule.cron, input.schedule.timeZone ?? "UTC").pipe(
		Result.map((cron) => Cron.next(cron, input.now).getTime()),
		Result.mapError(
			() =>
				`The schedule ${JSON.stringify(input.schedule.cron)} is not a valid cron text with this time zone.`,
		),
	)

const hashSecret = (secret: string) =>
	createHash("sha256").update(secret).digest("hex")

const unavailable = () => TriggersApi.TriggerStorageUnavailable.make({})
const notFound = (id: string) => TriggersApi.TriggerNotFound.make({ id })
const invalid = (message: string) =>
	TriggersApi.TriggerInvalid.make({ message })

export type Failure =
	| TriggersApi.TriggerNotFound
	| TriggersApi.TriggerConflict
	| TriggersApi.TriggerInvalid
	| TriggersApi.TriggerStorageUnavailable
	| Permissions.PermissionDenied
	| Permissions.AuthorizationUnavailable

/** The triggers of an organization: their prompts, schedules and webhooks. */
export class Triggers extends Context.Service<
	Triggers,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<ReadonlyArray<Trigger>, Failure, AuthorizationServices>
		/** Reads a trigger. With `triggers.write`, the caller must also be able to change it. */
		readonly get: (
			caller: Caller,
			id: string,
			permission?: "triggers.read" | "triggers.write",
		) => Effect.Effect<Trigger, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: {
				readonly agent: AgentsApi.AgentId
				readonly prompt: string
				readonly schedule?: TriggersApi.Schedule
				readonly shared?: boolean
				readonly enabled?: boolean
			},
		) => Effect.Effect<Trigger, Failure, AuthorizationServices>
		/** Changes a trigger. The caller becomes its actor. */
		readonly update: (
			caller: Caller,
			id: string,
			input: TriggersApi.UpdateTriggerRequest,
		) => Effect.Effect<Trigger, Failure, AuthorizationServices>
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Trigger, Failure, AuthorizationServices>
		/** Makes a new webhook secret. The old one stops working. The caller becomes the actor. */
		readonly setWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			{ readonly trigger: Trigger; readonly secret: string },
			Failure,
			AuthorizationServices
		>
		readonly removeWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Trigger, Failure, AuthorizationServices>
		/** The enabled trigger that this secret opens. */
		readonly verifyHook: (
			id: string,
			secret: string,
		) => Effect.Effect<
			Option.Option<{
				readonly organizationId: string
				readonly trigger: Trigger
			}>,
			TriggersApi.TriggerStorageUnavailable
		>
		/**
		 * The triggers whose schedule is due, in every organization. Each one moves on to
		 * its next time in the same step, so two instances never fire it twice.
		 */
		readonly due: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly trigger: Trigger
			}>,
			TriggersApi.TriggerStorageUnavailable
		>
		readonly fired: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, TriggersApi.TriggerStorageUnavailable>
	}
>()("@openbot-build/openbot/triggers/Triggers") {}

const fromRow = (row: Row): Trigger => ({
	id: TriggersApi.TriggerId.make(row.id),
	owner:
		row.ownerUserId === null
			? { _tag: "Organization" }
			: { _tag: "Member", userId: row.ownerUserId },
	agent: row.agent as AgentsApi.AgentId,
	prompt: row.prompt,
	schedule:
		row.scheduleCron === null
			? null
			: {
					cron: row.scheduleCron,
					...(row.scheduleTimeZone === null
						? {}
						: { timeZone: row.scheduleTimeZone }),
				},
	webhook: row.hookSecretHash !== null,
	actor: row.actor,
	enabled: row.enabled,
	nextRunAt: row.nextRunAt,
	lastFiredAt: row.lastFiredAt,
	revision: row.revision,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** The time of the next scheduled start, or null when the trigger does not fire by itself. */
const nextOf = (trigger: Pick<Trigger, "schedule" | "enabled">, now: number) =>
	!trigger.enabled || trigger.schedule === null
		? null
		: Result.getOrNull(nextRun({ schedule: trigger.schedule, now }))

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const where = (organizationId: string, id: string) =>
		and(eq(triggers.organizationId, organizationId), eq(triggers.id, id))
	const find = (organizationId: string, id: string) =>
		stored(db.select().from(triggers).where(where(organizationId, id))).pipe(
			Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), fromRow)),
		)
	const keyOf = (caller: Caller, trigger: Pick<Trigger, "id" | "owner">) =>
		triggerKey({ ...trigger, organizationId: caller.organizationId })
	/** A caller who cannot read a trigger does not learn that it exists. */
	const access = (
		caller: Caller,
		id: string,
		permission: Permissions.PermissionGroupId,
	) =>
		Effect.gen(function* () {
			const found = yield* find(caller.organizationId, id)
			if (Option.isNone(found)) return yield* notFound(id)
			const key = keyOf(caller, found.value)
			if (!(yield* can({ caller, permission: "triggers.read", key })))
				return yield* notFound(id)
			if (
				permission !== "triggers.read" &&
				!(yield* can({ caller, permission, key }))
			)
				return yield* Permissions.PermissionDenied.make({
					permission,
					resource: key,
				})
			return found.value
		})
	const check = (schedule: TriggersApi.Schedule | null, now: number) =>
		schedule === null
			? Effect.void
			: Result.match(nextRun({ schedule, now }), {
					onFailure: (message) => Effect.fail(invalid(message)),
					onSuccess: () => Effect.void,
				})
	const save = (
		organizationId: string,
		trigger: Trigger,
		hash: string | null,
		expected?: number,
	) =>
		Effect.gen(function* () {
			const values = {
				organizationId,
				id: trigger.id,
				ownerUserId:
					trigger.owner._tag === "Member" ? trigger.owner.userId : null,
				agent: trigger.agent,
				prompt: trigger.prompt,
				scheduleCron: trigger.schedule?.cron ?? null,
				scheduleTimeZone: trigger.schedule?.timeZone ?? null,
				nextRunAt: trigger.nextRunAt,
				lastFiredAt: trigger.lastFiredAt,
				hookSecretHash: hash,
				actor: trigger.actor,
				enabled: trigger.enabled,
				revision: trigger.revision,
				createdAt: trigger.createdAt,
				updatedAt: trigger.updatedAt,
			}
			if (expected === undefined) {
				yield* stored(db.insert(triggers).values(values))
				return trigger
			}
			const changed = yield* stored(
				db
					.update(triggers)
					.set(values)
					.where(
						and(
							where(organizationId, trigger.id),
							eq(triggers.revision, expected),
						),
					)
					.returning({ id: triggers.id }),
			)
			if (changed.length === 0)
				return yield* TriggersApi.TriggerConflict.make({
					message: "The trigger changed. Read it again and retry.",
				})
			return trigger
		})
	const hashOf = (organizationId: string, id: string) =>
		stored(
			db
				.select({ hash: triggers.hookSecretHash })
				.from(triggers)
				.where(where(organizationId, id)),
		).pipe(Effect.map((rows) => rows[0]?.hash ?? null))
	/** Saves a change of a trigger that the caller may write. */
	const change = (
		caller: Caller,
		id: string,
		expected: number | undefined,
		update: (
			trigger: Trigger,
			now: number,
		) => Effect.Effect<
			{ readonly trigger: Trigger; readonly hash?: string | null },
			Failure
		>,
	) =>
		Effect.gen(function* () {
			const current = yield* access(caller, id, "triggers.write")
			if (expected !== undefined && expected !== current.revision)
				return yield* TriggersApi.TriggerConflict.make({
					message: "The trigger changed. Read it again and retry.",
				})
			const now = yield* Clock.currentTimeMillis
			const next = yield* update(current, now)
			const trigger: Trigger = {
				...next.trigger,
				actor: caller.userId,
				nextRunAt: nextOf(next.trigger, now),
				revision: current.revision + 1,
				updatedAt: now,
			}
			const hash =
				next.hash === undefined
					? yield* hashOf(caller.organizationId, id)
					: next.hash
			return yield* save(caller.organizationId, trigger, hash, current.revision)
		})
	return Triggers.of({
		list: (caller) =>
			Effect.gen(function* () {
				const places = [caller.userId, null] as const
				const readable: Array<string | null> = []
				for (const userId of places)
					if (
						yield* can({
							caller,
							permission: "triggers.read",
							key: triggerPlace({
								organizationId: caller.organizationId,
								userId,
							}),
						})
					)
						readable.push(userId)
				if (readable.length === 0) return []
				const rows = yield* stored(
					db
						.select()
						.from(triggers)
						.where(
							and(
								eq(triggers.organizationId, caller.organizationId),
								or(
									...readable.map((userId) =>
										userId === null
											? isNull(triggers.ownerUserId)
											: eq(triggers.ownerUserId, userId),
									),
								),
							),
						)
						.orderBy(triggers.createdAt),
				)
				return rows.map(fromRow)
			}),
		get: (caller, id, permission = "triggers.read") =>
			access(caller, id, permission),
		create: (caller, input) =>
			Effect.gen(function* () {
				const owner: TriggersApi.TriggerOwner =
					input.shared === true
						? { _tag: "Organization" }
						: { _tag: "Member", userId: caller.userId }
				const place = triggerPlace({
					organizationId: caller.organizationId,
					userId: owner._tag === "Member" ? owner.userId : null,
				})
				if (!(yield* can({ caller, permission: "triggers.write", key: place })))
					return yield* Permissions.PermissionDenied.make({
						permission: "triggers.write",
						resource: place,
					})
				const now = yield* Clock.currentTimeMillis
				const schedule = input.schedule ?? null
				yield* check(schedule, now)
				const enabled = input.enabled ?? true
				const trigger: Trigger = {
					id: TriggersApi.TriggerId.make(
						"trg_" + randomBytes(16).toString("hex"),
					),
					owner,
					agent: input.agent,
					prompt: input.prompt,
					schedule,
					webhook: false,
					actor: caller.userId,
					enabled,
					nextRunAt: nextOf({ schedule, enabled }, now),
					lastFiredAt: null,
					revision: 0,
					createdAt: now,
					updatedAt: now,
				}
				return yield* save(caller.organizationId, trigger, null)
			}),
		update: (caller, id, input) =>
			change(caller, id, input.expected, (current, now) =>
				Effect.gen(function* () {
					const schedule =
						input.schedule === undefined ? current.schedule : input.schedule
					yield* check(schedule, now)
					return {
						trigger: {
							...current,
							...(input.agent === undefined ? {} : { agent: input.agent }),
							...(input.prompt === undefined ? {} : { prompt: input.prompt }),
							...(input.enabled === undefined
								? {}
								: { enabled: input.enabled }),
							schedule,
						},
					}
				}),
			),
		remove: (caller, id) =>
			Effect.gen(function* () {
				const trigger = yield* access(caller, id, "triggers.write")
				yield* stored(
					db.delete(triggers).where(where(caller.organizationId, id)),
				)
				return trigger
			}),
		setWebhook: (caller, id) =>
			Effect.gen(function* () {
				const secret = "otg_" + randomBytes(32).toString("base64url")
				const trigger = yield* change(caller, id, undefined, (current) =>
					Effect.succeed({
						trigger: { ...current, webhook: true },
						hash: hashSecret(secret),
					}),
				)
				return { trigger, secret }
			}),
		removeWebhook: (caller, id) =>
			change(caller, id, undefined, (current) =>
				Effect.succeed({ trigger: { ...current, webhook: false }, hash: null }),
			),
		verifyHook: (id, secret) =>
			Effect.gen(function* () {
				const row = (yield* stored(
					db.select().from(triggers).where(eq(triggers.id, id)),
				))[0]
				if (row === undefined || row.hookSecretHash === null || !row.enabled)
					return Option.none()
				const expected = Buffer.from(row.hookSecretHash, "hex")
				const given = Buffer.from(hashSecret(secret), "hex")
				if (!timingSafeEqual(expected, given)) return Option.none()
				return Option.some({
					organizationId: row.organizationId,
					trigger: fromRow(row),
				})
			}),
		due: stored(
			db.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* tx
						.select()
						.from(triggers)
						.where(
							and(eq(triggers.enabled, true), lte(triggers.nextRunAt, now)),
						)
						.limit(100)
						.for("update", { skipLocked: true })
					return yield* Effect.forEach(rows, (row) =>
						Effect.gen(function* () {
							const trigger = fromRow(row)
							yield* tx
								.update(triggers)
								.set({ nextRunAt: nextOf(trigger, now) })
								.where(where(row.organizationId, row.id))
							return { organizationId: row.organizationId, trigger }
						}),
					)
				}),
			),
		),
		fired: (organizationId, id) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.update(triggers)
						.set({ lastFiredAt: now })
						.where(where(organizationId, id)),
				)
			}),
	})
})
export const layer = Layer.effect(Triggers, make)
