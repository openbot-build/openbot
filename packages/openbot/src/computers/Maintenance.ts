import {
	type ServiceExecution,
	Store,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	type Bots as BotsType,
	type Computers,
	Execution,
	ServiceId,
	type Caller,
	type ServiceIdentity,
} from "@openbot-build/domain"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import type { Machine, ComputerError } from "./Computer.ts"
import { and, eq, isNull, lt } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Bots } from "../bots/Bots.ts"
import * as Db from "../database/Database.ts"
import {
	computerAccess,
	computerPairings,
	computers,
	computerUsage,
} from "../database/Schema.ts"
import {
	type Access as ExecutionAccess,
	type DecisionCommand,
} from "../execution/Engine.ts"
import type { End } from "../execution/Program.ts"
import * as Access from "./Access.ts"
import * as Activity from "./Activity.ts"
import { ComputerProviders } from "./ComputerProviders.ts"
import { Drivers } from "./Drivers.ts"

export const serviceId = ServiceId.make("computer-maintenance")
export const sweepWorkflowName = "openbot.computer-maintenance"
export const sweepNamespace = "computer-maintenance"
const interval = 60000
const sweepIdentity: ServiceIdentity = {
	owner: { kind: "platform" },
	actor: { kind: "service", serviceId },
}
export const SweepInput = Schema.Struct({ due: Schema.Finite })
export const PauseInput = Schema.Struct({
	computerId: Schema.String,
	providerId: Schema.String,
	ref: Schema.String,
	version: Schema.Int,
	lastActiveAt: Schema.Finite,
	pauseAfter: Schema.Finite,
})
const idle = (row: typeof computers.$inferSelect, now: number) =>
	row.source === "provider" &&
	row.state === "running" &&
	row.pauseAfter !== null &&
	now - (row.lastActiveAt ?? row.updatedAt) >= row.pauseAfter * 1000

export interface Service {
	readonly bootstrap: Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly loadSweep: (
		key: Key,
	) => Effect.Effect<
		{ readonly due: number },
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly loadPause: (key: Key) => Effect.Effect<
		{
			saved: ServiceExecution
			input: typeof PauseInput.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorizePause: (
		key: Key,
		access: ExecutionAccess,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly publicAccess: (
		key: Key,
		caller: Caller,
		access: ExecutionAccess,
	) => Effect.Effect<
		undefined,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly decide: (
		key: Key,
		caller: Caller,
		input: DecisionCommand,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly sweep: (
		fence: Fence,
	) => Effect.Effect<
		void,
		| BotsType.BotStorageUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly finishSweep: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly prepare: (
		fence: Fence,
	) => Effect.Effect<
		Machine,
		| Computers.ComputerProviderNotFound
		| Computers.ComputersUnavailable
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
		| ComputerError
	>
	readonly complete: (
		fence: Fence,
		paused: boolean,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class Maintenance extends Context.Service<Maintenance, Service>()(
	"@openbot-build/openbot/computers/Maintenance",
) {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const bots = yield* Bots
	const providers = yield* ComputerProviders
	const drivers = yield* Drivers
	const activity = yield* Activity.make
	const rights = yield* Access.make
	const schedule = (due: number) =>
		store.submit(
			sweepNamespace,
			Execution.CommandKey.make(`computer-check:${due}`),
			{
				workflow: sweepWorkflowName,
				identity: sweepIdentity,
				resource: { kind: "ComputerMaintenance", id: "idle" },
				input: { due },
			},
		)
	const loadSweep = Effect.fn("ComputerMaintenance.loadSweep")(
		function* (key: Key) {
			const saved = yield* store.loadService(key, serviceId)
			if (
				key.namespace !== sweepNamespace ||
				saved.workflow !== sweepWorkflowName ||
				saved.identity.owner.kind !== "platform"
			)
				return yield* Execution.Forbidden.make({})
			return yield* Schema.decodeUnknownEffect(SweepInput)(saved.input)
		},
		transactionFailures,
		Effect.catchTag("SchemaError", Effect.die),
	)
	const loadPause = Effect.fn("ComputerMaintenance.loadPause")(
		function* (key: Key) {
			const saved = yield* store.loadService(key, serviceId)
			if (
				saved.workflow !== Activity.pauseWorkflowName ||
				saved.identity.owner.kind !== "organization" ||
				saved.identity.owner.organizationId !== key.namespace
			)
				return yield* Execution.Forbidden.make({})
			const input = yield* Schema.decodeUnknownEffect(PauseInput)(saved.input)
			if (
				saved.record.resource.kind !== "Computer" ||
				saved.record.resource.id !== input.computerId
			)
				return yield* Execution.Forbidden.make({})
			return { saved, input }
		},
		transactionFailures,
		Effect.catchTag("SchemaError", Effect.die),
	)
	const pauseRow = Effect.fn("ComputerMaintenance.pauseRow")(function* (
		key: Key,
		lock = false,
	) {
		const { saved, input } = yield* loadPause(key)
		const found = yield* activity.row(key.namespace, input.computerId, lock)
		if (Option.isNone(found))
			return yield* Execution.NotFound.make({ id: key.id })
		const row = found.value
		if (
			row.providerId !== input.providerId ||
			row.ref !== input.ref ||
			row.version !== input.version ||
			row.pauseAfter !== input.pauseAfter ||
			(row.lastActiveAt ?? row.updatedAt) !== input.lastActiveAt
		)
			return yield* Execution.Forbidden.make({})
		return { saved, input, row }
	}, transactionFailures)
	const authorizePause = (key: Key, access: ExecutionAccess) =>
		(access === "advance" ? pauseRow(key) : loadPause(key)).pipe(Effect.asVoid)
	const publicAccess = Effect.fn("ComputerMaintenance.publicAccess")(function* (
		key: Key,
		caller: Caller,
		access: ExecutionAccess,
	) {
		const { input } = yield* loadPause(key)
		if (
			caller.organizationId !== key.namespace ||
			(access !== "read" && access !== "decide")
		)
			return yield* Execution.Forbidden.make({})
		yield* rights
			.get(caller, input.computerId, access === "read" ? "read" : "write")
			.pipe(
				Effect.catchTag("ComputerNotFound", () =>
					Effect.fail(Execution.NotFound.make({ id: key.id })),
				),
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
					PolicyUnavailable: (cause) =>
						Effect.fail(Execution.StorageError.make({ cause })),
					ComputerStorageError: (cause) =>
						Effect.fail(Execution.StorageError.make({ cause })),
				}),
			)
	}, transactionFailures)
	const decide = (key: Key, caller: Caller, input: DecisionCommand) =>
		Effect.gen(function* () {
			yield* publicAccess(key, caller, "decide")
			// No provider promises that a second pause has the same result as the first one.
			if (input.answer !== "stop") return yield* Execution.Forbidden.make({})
			return yield* store.decide(
				key,
				input.commandKey,
				input.decisionId,
				input.answer,
				caller,
			)
		})
	const sweep = Effect.fn("ComputerMaintenance.sweep")(function* (
		fence: Fence,
	) {
		const input = yield* loadSweep(fence)
		return yield* store
			.commit(
				fence,
				{ status: "completed" },
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* db
						.select()
						.from(computers)
						.where(
							and(
								eq(computers.source, "provider"),
								eq(computers.state, "running"),
							),
						)
					for (const candidate of rows) {
						const found = yield* activity.row(
							candidate.organizationId,
							candidate.id,
							true,
						)
						if (Option.isNone(found)) continue
						const row = found.value
						if (
							!idle(row, now) ||
							row.providerId === null ||
							row.ref === null ||
							row.pauseAfter === null
						)
							continue
						if (
							Option.isSome(yield* activity.active(row.organizationId, row.id))
						)
							continue
						yield* store.submit(
							row.organizationId,
							Execution.CommandKey.make(`idle:${fence.id}:${row.id}`),
							{
								workflow: Activity.pauseWorkflowName,
								identity: {
									owner: {
										kind: "organization",
										organizationId: row.organizationId,
									},
									actor: { kind: "service", serviceId },
								},
								resource: { kind: "Computer", id: row.id },
								input: {
									computerId: row.id,
									providerId: row.providerId,
									ref: row.ref,
									version: row.version,
									lastActiveAt: row.lastActiveAt ?? row.updatedAt,
									pauseAfter: row.pauseAfter,
								},
							},
						)
					}
					yield* db
						.delete(computerPairings)
						.where(lt(computerPairings.expiresAt, now - 24 * 60 * 60 * 1000))
					const access = yield* db
						.selectDistinct({
							organizationId: computerAccess.organizationId,
							bot: computerAccess.bot,
						})
						.from(computerAccess)
					for (const entry of access) {
						const bot = yield* bots.find(entry.organizationId, entry.bot)
						if (Option.isSome(bot) && !bot.value.archived) continue
						yield* db
							.delete(computerAccess)
							.where(
								and(
									eq(computerAccess.organizationId, entry.organizationId),
									eq(computerAccess.bot, entry.bot),
								),
							)
					}
					yield* schedule(Math.max(input.due + interval, now + interval))
				}),
			)
			.pipe(transactionFailures)
	})
	const finishSweep = (fence: Fence, end: End) =>
		Effect.gen(function* () {
			const input = yield* loadSweep(fence)
			const next = schedule(
				Math.max(
					input.due + interval,
					(yield* Clock.currentTimeMillis) + interval,
				),
			).pipe(Effect.asVoid)
			if (end.status === "cancelled")
				return yield* store
					.finishCancellation(fence, end.epoch, () => next.pipe(Effect.as([])))
					.pipe(Effect.asVoid)
			return yield* store.commit(fence, end, next)
		})
	const prepare = Effect.fn("ComputerMaintenance.prepare")(function* (
		fence: Fence,
	) {
		const { input } = yield* pauseRow(fence)
		const { credentials } = yield* providers.credentials(
			fence.namespace,
			input.providerId,
		)
		const provider = yield* drivers.make(credentials)
		return yield* provider.attach(input.ref)
	})
	const changeState = (fence: Fence, state: "paused" | "failed") =>
		Effect.gen(function* () {
			const { row } = yield* pauseRow(fence, true)
			const now = yield* Clock.currentTimeMillis
			yield* db
				.update(computers)
				.set({ state, updatedAt: now })
				.where(Activity.where(fence.namespace, row.id))
			if (state === "paused")
				yield* db
					.update(computerUsage)
					.set({ endedAt: now })
					.where(
						and(
							eq(computerUsage.organizationId, fence.namespace),
							eq(computerUsage.computerId, row.id),
							isNull(computerUsage.endedAt),
						),
					)
		})
	const complete = (fence: Fence, paused: boolean) =>
		store
			.commit(
				fence,
				{ status: "completed" },
				paused ? changeState(fence, "paused") : Effect.void,
			)
			.pipe(transactionFailures)
	const finish = (fence: Fence, end: End) =>
		Effect.gen(function* () {
			const calls = yield* store.calls(fence)
			const uncertain = Arr.some(calls, (call) => call.status !== "intended")
			const change = uncertain ? changeState(fence, "failed") : Effect.void
			if (end.status === "cancelled")
				return yield* store
					.finishCancellation(fence, end.epoch, () =>
						change.pipe(Effect.as([])),
					)
					.pipe(Effect.asVoid)
			return yield* store.commit(fence, end, change)
		}).pipe(transactionFailures)
	return Maintenance.of({
		bootstrap: schedule(0).pipe(Effect.asVoid),
		loadSweep,
		loadPause,
		authorizePause,
		publicAccess,
		decide,
		sweep,
		finishSweep,
		prepare,
		complete,
		finish,
	})
})

export const layer = Layer.effect(Maintenance, make)
