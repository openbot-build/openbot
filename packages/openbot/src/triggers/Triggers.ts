import { SqlClient } from "effect/sql"
import { Secrets } from "../secrets/Secrets.ts"
import { Store, storage, type Key } from "../execution/Store.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
export const workflowName = "openbot.trigger-schedule"
export const ScheduleInput = Schema.Struct({
	triggerId: Domain.TriggerId,
	revision: Schema.Natural,
	dueAt: Schema.Finite,
})
export interface Saved {
	readonly trigger: Trigger
	readonly caller: Option.Option<Caller>
}
const Data = Schema.fromJsonString(
	Schema.Struct({ prompt: Schema.String, caller: Schema.NullOr(Caller) }),
)
const binding = (organizationId: string, id: string) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
		"trigger",
		organizationId,
		id,
	])
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API to compare secrets in constant time.
import { timingSafeEqual } from "node:crypto"
import { Triggers as Domain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Caller, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Clock,
	Context,
	Cron,
	Crypto,
	Effect,
	Layer,
	Option,
	Result,
	Schema,
} from "effect"
import { Base64Url, Hex } from "effect/encoding"
import * as Failures from "../errors/Failures.ts"
import * as Check from "../authorization/Check.ts"
import { triggerResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import { triggers } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"

type Trigger = Domain.Trigger
type Row = typeof triggers.$inferSelect

const encoder = new TextEncoder()

/**
 * The next time after `now` that a schedule fires, or why it is not valid. A
 * cron text can parse and still never fire, such as `0 0 30 2 *` (February
 * 30). `Cron.next` throws then, so this catches it.
 */
export const nextRun = (input: {
	readonly schedule: Domain.Schedule
	readonly now: number
}) =>
	Cron.parse(input.schedule.cron, input.schedule.timeZone ?? "UTC").pipe(
		Result.mapError(
			(error) =>
				`The schedule ${JSON.stringify(input.schedule.cron)} is not a valid cron text with this time zone: ${error.message}.`,
		),
		Result.flatMap((cron) =>
			Result.try({
				try: () => Cron.next(cron, input.now).getTime(),
				catch: (error) =>
					`The schedule ${JSON.stringify(input.schedule.cron)} never fires with this time zone (${String(error)}).`,
			}),
		),
	)

export type Failure =
	| Domain.TriggerNotFound
	| Domain.TriggerConflict
	| Domain.TriggerInvalid
	| Domain.TriggerStorageUnavailable
	| Check.Errors

/** The triggers of an organization: their prompts, schedules and webhooks. */
export class Triggers extends Context.Service<
	Triggers,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<ReadonlyArray<Trigger>, Failure>
		/** Reads a trigger. With `write`, the caller must also be able to change it. */
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "write",
		) => Effect.Effect<Trigger, Failure>
		readonly create: (
			caller: Caller,
			input: {
				readonly bot: BotsApi.BotId
				readonly prompt: string
				readonly schedule?: Domain.Schedule
				readonly shared?: boolean
				readonly enabled?: boolean
			},
		) => Effect.Effect<Trigger, Failure>
		/** Changes a trigger. The caller becomes its actor. */
		readonly update: (
			caller: Caller,
			id: string,
			input: Domain.Change,
		) => Effect.Effect<Trigger, Failure>
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Trigger, Failure>
		/** Makes a new webhook secret. The old one stops working. The caller becomes the actor. */
		readonly setWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			{ readonly trigger: Trigger; readonly secret: string },
			Failure
		>
		readonly removeWebhook: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Trigger, Failure>
		/** The enabled trigger that this secret opens. */
		readonly verifyHook: (
			id: string,
			secret: string,
		) => Effect.Effect<
			Option.Option<{
				readonly organizationId: string
				readonly trigger: Trigger
			}>,
			Domain.TriggerStorageUnavailable
		>
		readonly read: (
			organizationId: string,
			id: string,
			lock?: boolean,
		) => Effect.Effect<Option.Option<Saved>, Domain.TriggerStorageUnavailable>
		readonly advance: (
			key: Key,
			trigger: Trigger,
		) => Effect.Effect<
			void,
			| Execution.StorageError
			| Execution.Conflict
			| Execution.Forbidden
			| Execution.NotFound
			| Execution.KeyConflict
		>

		readonly fired: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, Domain.TriggerStorageUnavailable>
	}
>()("@openbot-build/openbot/triggers/Triggers") {}

const view = (
	row: Row,
	prompt: string,
	needsAuthorization: boolean,
): Trigger => ({
	id: Domain.TriggerId.make(row.id),
	owner:
		row.ownerUserId === null
			? { _tag: "Organization" }
			: { _tag: "Member", userId: row.ownerUserId },
	bot: BotsApi.BotId.make(row.bot),
	prompt,
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
	needsAuthorization,
	nextRunAt: row.nextRunAt,
	executionId:
		row.scheduleExecutionId === null
			? null
			: Execution.Id.make(row.scheduleExecutionId),
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
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const store = yield* Store
	const fromRow = (row: Row) =>
		Effect.gen(function* () {
			const data = yield* secrets
				.open(row.prompt, yield* binding(row.organizationId, row.id))
				.pipe(Effect.flatMap(Schema.decodeEffect(Data)))
			if (
				data.caller !== null &&
				(data.caller.organizationId !== row.organizationId ||
					data.caller.userId !== row.actor)
			)
				return yield* Domain.TriggerInvalid.make({
					message: "The trigger identity does not match its record.",
				})
			return {
				trigger: view(row, data.prompt, data.caller === null),
				caller: Option.fromNullishOr(data.caller),
			}
		}).pipe(
			Failures.replace("The saved trigger could not be opened.", () =>
				Domain.TriggerStorageUnavailable.make({}),
			),
		)
	const crypto = yield* Crypto.Crypto
	const { check: checkAct, filter, guard } = yield* Check.make
	// OpenBot needs secure random numbers and SHA-256 to run, so a failure here is a defect.
	const randomBytes = (size: number) =>
		crypto.randomBytes(size).pipe(Effect.orDie)
	const sha = (value: string) =>
		crypto.digest("SHA-256", encoder.encode(value)).pipe(Effect.orDie)
	const stored = (message: string) =>
		Failures.replace(message, () => Domain.TriggerStorageUnavailable.make({}))
	const where = (organizationId: string, id: string) =>
		and(eq(triggers.organizationId, organizationId), eq(triggers.id, id))
	const read = (organizationId: string, id: string, lock = false) =>
		Effect.gen(function* () {
			const query = db.select().from(triggers).where(where(organizationId, id))
			const rows = yield* (lock ? query.for("update") : query).pipe(
				stored("A trigger could not be read."),
			)
			return rows[0] === undefined
				? Option.none<Saved>()
				: Option.some(yield* fromRow(rows[0]))
		})
	const find = (organizationId: string, id: string) =>
		read(organizationId, id).pipe(
			Effect.map(Option.map((value) => value.trigger)),
		)
	const schedule = (caller: Caller, trigger: Trigger) =>
		Effect.gen(function* () {
			if (trigger.nextRunAt === null) return null
			const receipt = yield* store.submit(
				ownerKey(caller),
				Execution.CommandKey.make(
					`trigger-schedule:${trigger.id}:${trigger.revision}:${trigger.nextRunAt}`,
				),
				{
					workflow: workflowName,
					resource: { kind: "TriggerSchedule", id: trigger.id },
					identity: {
						owner: {
							organizationId: caller.organizationId,
							userId: caller.userId,
						},
						actor: caller,
						botId: trigger.bot,
					},
					input: {
						triggerId: trigger.id,
						revision: trigger.revision,
						dueAt: trigger.nextRunAt,
					},
				},
			)
			return receipt.executionId
		})
	const cancelSchedule = (saved: Saved) =>
		saved.trigger.executionId === null || Option.isNone(saved.caller)
			? Effect.void
			: store
					.cancel(
						{
							namespace: ownerKey(saved.caller.value),
							id: saved.trigger.executionId,
						},
						Execution.CommandKey.make(
							`trigger-stop:${saved.trigger.executionId}`,
						),
						saved.caller.value,
					)
					.pipe(Effect.asVoid)

	/** A caller who cannot read a trigger does not learn that it exists. */
	const access = (caller: Caller, id: string, action: "read" | "write") =>
		Effect.gen(function* () {
			const found = yield* find(caller.organizationId, id)
			if (Option.isNone(found))
				return yield* Domain.TriggerNotFound.make({ id })
			yield* guard(
				caller,
				{
					action,
					resource: triggerResource({
						...found.value,
						organizationId: caller.organizationId,
					}),
				},
				{
					hide: () => Domain.TriggerNotFound.make({ id }),
				},
			)
			return found.value
		})
	const check = (schedule: Domain.Schedule | null, now: number) =>
		schedule === null
			? Effect.void
			: Result.match(nextRun({ schedule, now }), {
					onFailure: (message) =>
						Effect.fail(Domain.TriggerInvalid.make({ message })),
					onSuccess: () => Effect.void,
				})
	const save = (
		caller: Caller,
		trigger: Trigger,
		hash: string | null,
		expected?: number,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const organizationId = caller.organizationId
					const previous = yield* read(organizationId, trigger.id, true)
					const sealed = yield* secrets
						.seal(
							yield* Schema.encodeEffect(Data)({
								prompt: trigger.prompt,
								caller,
							}),
							yield* binding(organizationId, trigger.id),
						)
						.pipe(stored("The trigger input could not be saved."))
					const values = {
						organizationId,
						id: trigger.id,
						ownerUserId:
							trigger.owner._tag === "Member" ? trigger.owner.userId : null,
						bot: trigger.bot,
						prompt: sealed,
						scheduleCron: trigger.schedule?.cron ?? null,
						scheduleTimeZone: trigger.schedule?.timeZone ?? null,
						nextRunAt: trigger.nextRunAt,
						lastFiredAt: Option.isSome(previous)
							? previous.value.trigger.lastFiredAt
							: trigger.lastFiredAt,
						hookSecretHash: hash,
						actor: trigger.actor,
						enabled: trigger.enabled,
						revision: trigger.revision,
						createdAt: trigger.createdAt,
						updatedAt: trigger.updatedAt,
					}
					if (expected === undefined) {
						yield* db
							.insert(triggers)
							.values(values)
							.pipe(stored("A trigger could not be created."))
					} else {
						const changed = yield* db
							.update(triggers)
							.set(values)
							.where(
								and(
									where(organizationId, trigger.id),
									eq(triggers.revision, expected),
								),
							)
							.returning({ id: triggers.id })
							.pipe(stored("A trigger could not be changed."))
						if (changed.length === 0)
							return yield* Domain.TriggerConflict.make({
								message: "The trigger changed. Read it again and retry.",
							})
					}
					if (Option.isSome(previous))
						yield* cancelSchedule(previous.value).pipe(
							stored("The old trigger timer could not stop."),
						)
					const executionId = yield* schedule(caller, trigger).pipe(
						stored("The trigger timer could not start."),
					)
					yield* db
						.update(triggers)
						.set({ scheduleExecutionId: executionId })
						.where(where(organizationId, trigger.id))
						.pipe(stored("The trigger timer could not be saved."))
					return { ...trigger, lastFiredAt: values.lastFiredAt, executionId }
				}),
			)
			.pipe(
				Effect.catchTag(["SqlError", "SchemaError"], (error) =>
					Effect.fail(error).pipe(
						stored("The trigger change could not commit."),
					),
				),
			)
	const hashOf = (organizationId: string, id: string) =>
		db
			.select({ hash: triggers.hookSecretHash })
			.from(triggers)
			.where(where(organizationId, id))
			.pipe(
				stored("The webhook of a trigger could not be read."),
				Effect.map((rows) => rows[0]?.hash ?? null),
			)
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
			const current = yield* access(caller, id, "write")
			if (expected !== undefined && expected !== current.revision)
				return yield* Domain.TriggerConflict.make({
					message: "The trigger changed. Read it again and retry.",
				})
			const now = yield* Clock.currentTimeMillis
			const next = yield* update(current, now)
			const trigger: Trigger = {
				...next.trigger,
				actor: caller.userId,
				needsAuthorization: false,
				nextRunAt: nextOf(next.trigger, now),
				revision: current.revision + 1,
				updatedAt: now,
			}
			const hash =
				next.hash === undefined
					? yield* hashOf(caller.organizationId, id)
					: next.hash
			return yield* save(caller, trigger, hash, current.revision)
		})
	return Triggers.of({
		list: (caller) =>
			Effect.gen(function* () {
				const readable = yield* filter(caller, {
					action: "read",
					kind: "Trigger",
					within: ($) => $.eq("organizationId", caller.organizationId),
				}).pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: triggers.organizationId,
							ownerUserId: triggers.ownerUserId,
							id: triggers.id,
						}),
					),
				)
				const rows = yield* db
					.select()
					.from(triggers)
					.where(
						and(eq(triggers.organizationId, caller.organizationId), readable),
					)
					.orderBy(triggers.createdAt)
					.pipe(stored("The triggers could not be listed."))
				return yield* Effect.forEach(rows, (row) =>
					fromRow(row).pipe(Effect.map((value) => value.trigger)),
				)
			}),
		get: (caller, id, action = "read") => access(caller, id, action),
		create: (caller, input) =>
			Effect.gen(function* () {
				const owner: Domain.TriggerOwner =
					input.shared === true
						? { _tag: "Organization" }
						: { _tag: "Member", userId: caller.userId }
				yield* checkAct(caller, {
					action: "write",
					kind: "Trigger",
					within: ($) =>
						$.and(
							$.eq("organizationId", caller.organizationId),
							$.eq(
								"ownerUserId",
								owner._tag === "Member" ? owner.userId : null,
							),
						),
				})
				const now = yield* Clock.currentTimeMillis
				const schedule = input.schedule ?? null
				yield* check(schedule, now)
				const enabled = input.enabled ?? true
				const trigger: Trigger = {
					id: Domain.TriggerId.make(
						"trg_" + Hex.encode(yield* randomBytes(16)),
					),
					owner,
					bot: input.bot,
					prompt: input.prompt,
					schedule,
					webhook: false,
					actor: caller.userId,
					enabled,
					needsAuthorization: false,
					nextRunAt: nextOf({ schedule, enabled }, now),
					executionId: null,
					lastFiredAt: null,
					revision: 0,
					createdAt: now,
					updatedAt: now,
				}
				return yield* save(caller, trigger, null)
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
							...(input.bot === undefined ? {} : { bot: input.bot }),
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
			sql
				.withTransaction(
					Effect.gen(function* () {
						const saved = yield* read(caller.organizationId, id, true)
						const trigger = yield* access(caller, id, "write")
						yield* db
							.delete(triggers)
							.where(where(caller.organizationId, id))
							.pipe(stored("A trigger could not be deleted."))
						if (Option.isSome(saved))
							yield* cancelSchedule(saved.value).pipe(
								stored("The deleted trigger timer could not stop."),
							)
						return trigger
					}),
				)
				.pipe(
					Effect.catchTag("SqlError", (error) =>
						Effect.fail(error).pipe(
							stored("The trigger delete could not commit."),
						),
					),
				),
		setWebhook: (caller, id) =>
			Effect.gen(function* () {
				const secret = "otg_" + Base64Url.encode(yield* randomBytes(32))
				const hash = Hex.encode(yield* sha(secret))
				const trigger = yield* change(caller, id, undefined, (current) =>
					Effect.succeed({ trigger: { ...current, webhook: true }, hash }),
				)
				return { trigger, secret }
			}),
		removeWebhook: (caller, id) =>
			change(caller, id, undefined, (current) =>
				Effect.succeed({ trigger: { ...current, webhook: false }, hash: null }),
			),
		verifyHook: (id, secret) =>
			Effect.gen(function* () {
				const row = (yield* db
					.select()
					.from(triggers)
					.where(eq(triggers.id, id))
					.pipe(stored("The trigger of a webhook could not be read.")))[0]
				if (row === undefined || row.hookSecretHash === null || !row.enabled)
					return Option.none()
				const expected = Buffer.from(row.hookSecretHash, "hex")
				if (!timingSafeEqual(expected, yield* sha(secret))) return Option.none()
				const saved = yield* fromRow(row)
				if (Option.isNone(saved.caller)) return Option.none()
				return Option.some({
					organizationId: row.organizationId,
					trigger: saved.trigger,
				})
			}),
		read,
		advance: (key, trigger) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						const execution = yield* store.loadMember(key)
						const found = yield* read(
							execution.identity.owner.organizationId,
							trigger.id,
							true,
						)
						if (
							Option.isNone(found) ||
							found.value.trigger.executionId !== key.id ||
							found.value.trigger.revision !== trigger.revision
						)
							return yield* Execution.Conflict.make({ id: key.id })
						const next = {
							...found.value.trigger,
							nextRunAt: nextOf(
								found.value.trigger,
								yield* Clock.currentTimeMillis,
							),
						}
						if (Option.isNone(found.value.caller))
							return yield* Execution.Forbidden.make({})
						const executionId = yield* schedule(found.value.caller.value, next)
						yield* db
							.update(triggers)
							.set({
								nextRunAt: next.nextRunAt,
								scheduleExecutionId: executionId,
							})
							.where(where(execution.identity.owner.organizationId, trigger.id))
					}),
				)
				.pipe(storage),
		fired: (organizationId, id) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* db
					.update(triggers)
					.set({ lastFiredAt: now })
					.where(where(organizationId, id))
					.pipe(stored("The fire time of a trigger could not be saved."))
			}),
	})
})
export const layer = Layer.effect(Triggers, make)
