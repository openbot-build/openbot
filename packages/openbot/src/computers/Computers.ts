import { BotsApi, type Caller, ComputersApi } from "@openbot-build/api"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Layer,
	Option,
	Schema,
	Schedule,
} from "effect"
import { Base64, Base64Url, Hex } from "effect/encoding"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import { Bots } from "../bots/Bots.ts"
import * as Check from "../authorization/Check.ts"
import { computerResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { computerAccess, computers, computerUsage } from "../database/Schema.ts"
import { type ComputerError, Machine, type Pausable } from "./Computer.ts"
import { ComputerProviders } from "./ComputerProviders.ts"
import * as ConnectorMachine from "./connector/ConnectorMachine.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"
import * as Http from "./Http.ts"

const decodeId = Schema.decodeUnknownEffect(ComputersApi.ComputerId)
const decodeSource = Schema.decodeUnknownEffect(ComputersApi.ComputerSource)
const decodeBot = Schema.decodeUnknownEffect(BotsApi.BotId)
/** The state column holds one of the states of the API. */
const decodeState = Schema.decodeUnknownEffect(ComputersApi.ComputerState)

/** The features column holds JSON that only this file writes. */
const FeaturesJson = Schema.fromJsonString(ComputersApi.ComputerFeatures)
const decodeFeatures = Schema.decodeUnknownEffect(FeaturesJson)
/** The features are values of the API type, so they always encode. */
const encodeFeatures = (features: ComputersApi.ComputerFeatures) =>
	Schema.encodeEffect(FeaturesJson)(features).pipe(Effect.orDie)

/** A stored value that does not decode means a broken store. The log keeps the cause. */
const fromStore = <A>(decoded: Effect.Effect<A, Schema.SchemaError>) =>
	decoded.pipe(
		Failures.replace("A stored Computer has a bad value", () =>
			ComputersApi.ComputersUnavailable.make({}),
		),
	)

type Computer = ComputersApi.Computer
type Row = typeof computers.$inferSelect

const encoder = new TextEncoder()

// OpenBot needs secure random numbers and SHA-256 to run, so a failure of these is a defect.
export const hashToken = (crypto: Crypto.Crypto, token: string) =>
	crypto
		.digest("SHA-256", encoder.encode(token))
		.pipe(Effect.map(Hex.encode), Effect.orDie)

/** A new connector token. Only its hash is stored. */
export const newToken = (crypto: Crypto.Crypto) =>
	crypto.randomBytes(32).pipe(
		Effect.map((bytes) => "oct_" + Base64Url.encode(bytes)),
		Effect.orDie,
	)

export type Failure =
	| ComputersApi.ComputerProviderInUse
	| ComputersApi.ComputerPathNotFound
	| ComputersApi.ComputerNotFound
	| ComputersApi.ComputerProviderNotFound
	| ComputersApi.ComputerConflict
	| ComputersApi.ComputerInvalid
	| ComputersApi.ComputerUnsupported
	| ComputersApi.ComputerNotReady
	| ComputersApi.ComputerProviderFailed
	| ComputersApi.ComputersUnavailable
	| Check.Errors

/** A Computer is idle this long before OpenBot pauses it, unless it says otherwise. */
export const defaultPauseAfter = 10 * 60

/**
 * A running command marks its Computer as active this often. It must be shorter
 * than the shortest `pauseAfter`, which is 60 seconds.
 */
const activeInterval = Duration.seconds(30)

/** True when a Computer had no work for its `pauseAfter` seconds. */
const idle = (current: Row, now: number) =>
	current.pauseAfter !== null &&
	now - (current.lastActiveAt ?? current.updatedAt) >= current.pauseAfter * 1000

const fromRow = (
	row: Row,
): Effect.Effect<Computer, ComputersApi.ComputersUnavailable> =>
	fromStore(
		Effect.gen(function* () {
			return {
				id: yield* decodeId(row.id),
				name: row.name,
				owner:
					row.ownerUserId === null
						? { _tag: "Organization" }
						: { _tag: "Member", userId: row.ownerUserId },
				// A provider Computer with no provider, or another source, does not decode.
				source: yield* decodeSource(
					row.source === "connector"
						? { _tag: "Connector" }
						: row.source === "provider"
							? {
									_tag: "Provider",
									provider: row.providerId,
									template: row.template,
								}
							: { _tag: row.source },
				),
				state: yield* decodeState(row.state),
				features: yield* decodeFeatures(row.features),
				pauseAfter: row.pauseAfter,
				createdBy: row.createdBy,
				version: row.version,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				lastActiveAt: row.lastActiveAt,
			} satisfies Computer
		}),
	)

/** Maps an error of a driver or a connector to an error of the API. */
const fromDriver = (error: ComputerError) =>
	error._tag === "ComputerGone"
		? ComputersApi.ComputerNotReady.make({ state: "offline" })
		: error.missingPath !== undefined
			? ComputersApi.ComputerPathNotFound.make({ path: error.missingPath })
			: ComputersApi.ComputerProviderFailed.make({ message: error.message })

/**
 * Checks a file before a driver or a connector gets it. Bad base64 is a bad
 * input of the caller, not a failure of the provider.
 */
export const checkFile = (
	file: ComputersApi.FileContent,
): Effect.Effect<void, ComputersApi.ComputerInvalid> =>
	file.encoding === "base64"
		? Base64.decode(file.content).pipe(
				Effect.fromResult,
				Effect.mapError((error) =>
					ComputersApi.ComputerInvalid.make({
						message: `The file content is not valid base64: ${error.message}`,
					}),
				),
				Effect.asVoid,
			)
		: Effect.void

/** Which action a caller needs on a Computer. */
export type Need = "read" | "use" | "write"

/** The Computers of an organization, and the rights of Bots to use them. */
export class Computers extends Context.Service<
	Computers,
	{
		/** The Computers that the caller can read. With `bot`, only those that Bot may use. */
		readonly list: (
			caller: Caller,
			bot?: BotsApi.BotId,
		) => Effect.Effect<ReadonlyArray<Computer>, Failure>
		readonly get: (
			caller: Caller,
			id: string,
			need?: Need,
		) => Effect.Effect<Computer, Failure>
		/**
		 * Creates a Computer. `createdBy` is the Bot that made it for the caller.
		 * That Bot gets the right to use it.
		 */
		readonly create: (
			caller: Caller,
			input: ComputersApi.CreateComputerRequest,
			bot?: BotsApi.BotId,
		) => Effect.Effect<Computer, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: ComputersApi.UpdateComputerRequest,
		) => Effect.Effect<Computer, Failure>
		/**
		 * Deletes a Computer, its sandbox, and every right to use it. When OpenBot
		 * cannot reach the provider, it fails and the Computer stays.
		 */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure>
		readonly pause: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Computer, Failure>
		readonly resume: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Computer, Failure>
		/**
		 * Reads a Computer that the caller may use, and gets its machine ready.
		 * A paused Computer resumes first. Work marks the Computer as active, and a
		 * command of the machine keeps it active while the command runs.
		 */
		readonly machine: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			{ readonly computer: Computer; readonly machine: Machine },
			Failure
		>
		/** Maps an error of the machine to an error of the API. */
		readonly work: <A>(
			effect: Effect.Effect<A, ComputerError>,
		) => Effect.Effect<A, Failure>
		readonly setConnectorToken: (
			caller: Caller,
			id: string,
		) => Effect.Effect<string, Failure>
		/** The connector Computer that a token opens. */
		readonly byToken: (
			token: string,
		) => Effect.Effect<
			Option.Option<{ readonly organizationId: string; readonly id: string }>,
			ComputersApi.ComputersUnavailable
		>
		/** Marks a connector Computer as connected or not. */
		readonly connected: (
			organizationId: string,
			id: string,
			hello: Option.Option<ComputersApi.ConnectorHello>,
		) => Effect.Effect<void>
		/**
		 * Makes or finds the connector Computer of a machine that a person approved.
		 * The same machine in the same organization keeps its Computer.
		 */
		readonly pair: (
			caller: Caller,
			input: {
				readonly machineId: string
				readonly name: string
				readonly shared: boolean
				readonly desktop: boolean
			},
		) => Effect.Effect<
			{ readonly computer: Computer; readonly token: string },
			Failure
		>
		readonly bots: (
			caller: Caller,
			id: string,
		) => Effect.Effect<ReadonlyArray<ComputersApi.ComputerAccess>, Failure>
		/** Gives a Bot the right to use a Computer. The caller decides for the Bot. */
		readonly grant: (
			caller: Caller,
			id: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<ComputersApi.ComputerAccess, Failure>
		readonly revoke: (
			caller: Caller,
			id: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<void, Failure>
		/** The Bot gives up its own right to use the Computer. The Computer stays. */
		readonly release: (
			organizationId: string,
			bot: BotsApi.BotId,
			id: string,
		) => Effect.Effect<void, ComputersApi.ComputersUnavailable>
		/** Gives a Bot the right after its request was approved. It checks no permission. */
		readonly grantApproved: (
			organizationId: string,
			id: string,
			bot: BotsApi.BotId,
			grantedBy: string,
		) => Effect.Effect<
			ComputersApi.ComputerAccess,
			ComputersApi.ComputersUnavailable
		>
		/** True when the Bot has the right to use the Computer and is not archived. */
		readonly holds: (
			organizationId: string,
			bot: BotsApi.BotId,
			id: string,
		) => Effect.Effect<boolean, ComputersApi.ComputersUnavailable>
		/** The Computers of a Bot that it may use. */
		readonly heldBy: (
			organizationId: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<
			ReadonlyArray<Computer>,
			ComputersApi.ComputersUnavailable
		>
		readonly usage: (
			caller: Caller,
			id: string,
		) => Effect.Effect<ReadonlyArray<ComputersApi.ComputerUsage>, Failure>
		/** Pauses the Computers that had no work for longer than their `pauseAfter`. */
		readonly pauseIdle: Effect.Effect<void>
		/** Removes the rights of archived Bots. */
		readonly forgetArchived: Effect.Effect<void>
	}
>()("@openbot-build/openbot/computers/Computers") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const providers = yield* ComputerProviders
	const drivers = yield* Drivers
	const connectors = yield* Connectors
	const botsService = yield* Bots
	const crypto = yield* Crypto.Crypto
	const { check, filter, guard } = yield* Check.make
	const newId = crypto.randomBytes(16).pipe(
		Effect.map((bytes) => "cmp_" + Hex.encode(bytes)),
		Effect.orDie,
	)
	const stored = Failures.replace("The Computer store failed", () =>
		ComputersApi.ComputersUnavailable.make({}),
	)
	const botOf = (organizationId: string, id: string) =>
		botsService
			.find(organizationId, id)
			.pipe(
				Failures.replace("OpenBot could not read a Bot", () =>
					ComputersApi.ComputersUnavailable.make({}),
				),
			)
	const where = (organizationId: string, id: string) =>
		and(eq(computers.organizationId, organizationId), eq(computers.id, id))
	const row = (organizationId: string, id: string) =>
		stored(db.select().from(computers).where(where(organizationId, id))).pipe(
			Effect.map(Arr.head),
		)
	/** Reads a Computer again after a change. Another request may have deleted it. */
	const reread = (organizationId: string, id: string) =>
		Effect.gen(function* () {
			const found = yield* row(organizationId, id)
			if (Option.isNone(found))
				return yield* ComputersApi.ComputerNotFound.make({ id })
			return yield* fromRow(found.value)
		})
	/** Marks a Computer as active now, so the worker does not pause it. */
	const markActive = (organizationId: string, id: string) =>
		Effect.flatMap(Clock.currentTimeMillis, (now) =>
			stored(
				db
					.update(computers)
					.set({ lastActiveAt: now })
					.where(where(organizationId, id)),
			),
		)
	/** A caller who cannot read a Computer does not learn that it exists. */
	const access = (caller: Caller, id: string, need: Need) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found))
				return yield* ComputersApi.ComputerNotFound.make({ id })
			const computer = yield* fromRow(found.value)
			yield* guard(
				caller,
				{
					action: need,
					resource: computerResource({
						...computer,
						organizationId: caller.organizationId,
					}),
				},
				{
					hide: () => ComputersApi.ComputerNotFound.make({ id }),
				},
			)
			return { computer, row: found.value }
		})

	/**
	 * Changes the stored state, and opens or closes a usage record with it. Other
	 * requests can change the state at the same time, so this reads the state
	 * under a lock in the same transaction, and does not trust an older read.
	 * Then two resumes at the same time open only one usage record.
	 */
	const setState = (
		organizationId: string,
		id: string,
		state: ComputersApi.ComputerState,
	) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* stored(
				db.transaction((tx) =>
					Effect.gen(function* () {
						const locked = Arr.head(
							yield* tx
								.select()
								.from(computers)
								.where(where(organizationId, id))
								.for("update"),
						)
						if (Option.isNone(locked)) return
						yield* tx
							.update(computers)
							.set({ state, updatedAt: now, lastActiveAt: now })
							.where(where(organizationId, id))
						const running = state === "running"
						const wasRunning = locked.value.state === "running"
						if (running && !wasRunning)
							yield* tx.insert(computerUsage).values({
								organizationId,
								computerId: id,
								ownerUserId: locked.value.ownerUserId,
								startedAt: now,
							})
						if (!running && wasRunning)
							yield* tx
								.update(computerUsage)
								.set({ endedAt: now })
								.where(
									and(
										eq(computerUsage.computerId, id),
										isNull(computerUsage.endedAt),
									),
								)
					}),
				),
			)
		})

	/**
	 * Maps an error of the machine to an error of the API. The log keeps an inside
	 * cause. For a Computer that is gone, the API says only "offline", so the log
	 * keeps the reason, such as which sandbox the provider does not have.
	 */
	const work = <A>(effect: Effect.Effect<A, ComputerError>) =>
		effect.pipe(
			Effect.tapError((error) =>
				error._tag === "ComputerGone"
					? Effect.logInfo("A Computer is gone", Cause.fail(error))
					: Http.logCause(error),
			),
			Effect.mapError(fromDriver),
		)

	/**
	 * Resumes the machine at the provider, and stores the Computer as running.
	 * A stop can come after the provider started the sandbox, so then the store
	 * says running too. The worker pauses the sandbox again when it stays idle.
	 */
	const resumeStored = (
		organizationId: string,
		id: string,
		pausable: Pausable,
	) =>
		Effect.uninterruptibleMask((restore) =>
			restore(work(pausable.resume)).pipe(
				Effect.onInterrupt(() =>
					setState(organizationId, id, "running").pipe(
						Background.logFailure(
							"OpenBot could not store a Computer that it resumed",
						),
					),
				),
				Effect.andThen(setState(organizationId, id, "running")),
			),
		)

	/** The machine behind a stored Computer. */
	const machineOf = (current: Row) =>
		Effect.gen(function* () {
			if (current.source === "connector") {
				const features = yield* fromStore(decodeFeatures(current.features))
				return ConnectorMachine.make({
					computerId: current.id,
					desktop: features.desktop,
					connectors,
					online: current.state === "running",
				})
			}
			if (current.providerId === null || current.ref === null)
				return yield* ComputersApi.ComputerNotReady.make({ state: "failed" })
			const { credentials } = yield* providers.credentials(
				current.organizationId,
				current.providerId,
			)
			const provider = yield* drivers.make(credentials)
			return yield* work(provider.attach(current.ref))
		})

	/**
	 * A command that still runs is work, so the worker must not pause its
	 * Computer under it. While a command of this machine runs, this marks the
	 * Computer as active again and again. It runs on the instance that runs the
	 * command, also when nobody calls the Computer, and it stops with the
	 * command or when its scope closes.
	 */
	const keepActive = (organizationId: string, id: string, machine: Machine) =>
		new Machine({
			...machine,
			shell: {
				...machine.shell,
				start: (request) =>
					Effect.tap(machine.shell.start(request), (process) =>
						Effect.scoped(
							Effect.gen(function* () {
								yield* Background.repeat(
									markActive(organizationId, id).pipe(
										Effect.delay(activeInterval),
									),
									{
										schedule: Schedule.forever,
										message: "OpenBot could not mark a Computer as active",
									},
								)
								yield* process.exit
							}),
						).pipe(
							Effect.annotateLogs({
								computer: id,
								organization: organizationId,
							}),
							Effect.forkScoped,
						),
					),
			},
		})

	const insert = (values: typeof computers.$inferInsert) =>
		stored(db.insert(computers).values(values))

	const grantRow = (
		organizationId: string,
		computerId: string,
		bot: BotsApi.BotId,
		grantedBy: string,
	) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			// The update changes nothing. With it, one statement gives back the right
			// also when the Bot has it already, with its first `grantedBy` and time.
			const saved = Arr.head(
				yield* stored(
					db
						.insert(computerAccess)
						.values({
							organizationId,
							computerId,
							bot,
							grantedBy,
							grantedAt: now,
						})
						.onConflictDoUpdate({
							target: [computerAccess.computerId, computerAccess.bot],
							set: { bot },
						})
						.returning(),
				),
			)
			if (Option.isNone(saved))
				return yield* Effect.die("An insert with an update gave back no row")
			return {
				computer: yield* fromStore(decodeId(saved.value.computerId)),
				bot,
				grantedBy: saved.value.grantedBy,
				grantedAt: saved.value.grantedAt,
			} satisfies ComputersApi.ComputerAccess
		})

	const mayCreate = (caller: Caller, shared: boolean) =>
		check(caller, {
			action: "write",
			kind: "Computer",
			within: ($) =>
				$.and(
					$.eq("organizationId", caller.organizationId),
					$.eq("ownerUserId", shared ? null : caller.userId),
				),
		})

	const service: Computers["Service"] = {
		list: (caller, bot) =>
			Effect.gen(function* () {
				const readable = yield* filter(caller, {
					action: "read",
					kind: "Computer",
					within: ($) => $.eq("organizationId", caller.organizationId),
				}).pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: computers.organizationId,
							ownerUserId: computers.ownerUserId,
							id: computers.id,
						}),
					),
				)
				const held =
					bot === undefined
						? undefined
						: Arr.map(
								yield* stored(
									db
										.select({ id: computerAccess.computerId })
										.from(computerAccess)
										.where(
											and(
												eq(
													computerAccess.organizationId,
													caller.organizationId,
												),
												eq(computerAccess.bot, bot),
											),
										),
								),
								(entry) => entry.id,
							)
				if (held !== undefined && held.length === 0) return []
				const rows = yield* stored(
					db
						.select()
						.from(computers)
						.where(
							and(
								eq(computers.organizationId, caller.organizationId),
								readable,
								held === undefined ? undefined : inArray(computers.id, held),
							),
						)
						.orderBy(computers.createdAt),
				)
				return yield* Effect.forEach(rows, fromRow)
			}),
		get: (caller, id, need = "read") =>
			Effect.map(access(caller, id, need), (found) => found.computer),
		create: (caller, input, bot) =>
			Effect.gen(function* () {
				const shared = input.shared === true
				yield* mayCreate(caller, shared)
				const now = yield* Clock.currentTimeMillis
				const id = yield* newId
				const base = {
					organizationId: caller.organizationId,
					id,
					ownerUserId: shared ? null : caller.userId,
					name: input.name,
					pauseAfter:
						input.pauseAfter === undefined
							? defaultPauseAfter
							: input.pauseAfter,
					createdBy: bot ?? caller.userId,
					version: 0,
					createdAt: now,
					updatedAt: now,
					lastActiveAt: null,
				}
				if (input.source._tag === "Connector") {
					yield* insert({
						...base,
						source: "connector",
						state: "offline",
						features: yield* encodeFeatures({
							pause: false,
							desktop: false,
							ports: false,
						}),
						pauseAfter: null,
					})
				} else {
					const provider = yield* providers.get(
						caller,
						input.source.provider,
						"use",
					)
					const { credentials } = yield* providers.credentials(
						caller.organizationId,
						provider.id,
					)
					const driver = yield* drivers.make(credentials)
					const desktop = input.desktop === true
					const template = input.source.template
					const features = yield* encodeFeatures({
						pause: true,
						desktop,
						ports: true,
					})
					// The provider bills a sandbox from the moment it exists, and only the
					// stored ref can reach it later. So these steps run without a stop: when
					// the provider made the sandbox, OpenBot stores it, or deletes it again.
					// The row is stored as running in the same step, with its usage record
					// and the right of the Bot, so a stop after it leaves nothing half done.
					// The create call has its own time limit.
					yield* work(
						driver.create({
							...(template === null ? {} : { template }),
							desktop,
							labels: {
								openbot_computer: id,
								openbot_organization: caller.organizationId,
							},
						}),
					).pipe(
						Effect.flatMap((created) =>
							stored(
								db.transaction((tx) =>
									Effect.gen(function* () {
										const started = yield* Clock.currentTimeMillis
										yield* tx.insert(computers).values({
											...base,
											source: "provider",
											providerId: provider.id,
											template,
											ref: created.ref,
											state: "running",
											features,
											updatedAt: started,
											lastActiveAt: started,
										})
										yield* tx.insert(computerUsage).values({
											organizationId: caller.organizationId,
											computerId: id,
											ownerUserId: base.ownerUserId,
											startedAt: started,
										})
										if (bot !== undefined)
											yield* tx.insert(computerAccess).values({
												organizationId: caller.organizationId,
												computerId: id,
												bot,
												grantedBy: caller.userId,
												grantedAt: started,
											})
									}),
								),
							).pipe(
								Effect.onError(() =>
									driver.attach(created.ref).pipe(
										Effect.flatMap((machine) => machine.destroy),
										Background.logFailure(
											"OpenBot could not delete a sandbox that it did not store",
											{ level: "Error" },
										),
										Effect.annotateLogs({ sandbox: created.ref }),
									),
								),
							),
						),
						Effect.uninterruptible,
						Effect.annotateLogs({
							computer: id,
							organization: caller.organizationId,
							provider: provider.id,
						}),
					)
				}
				return yield* reread(caller.organizationId, id)
			}),
		update: (caller, id, input) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "write")
				if (input.expectedVersion !== computer.version)
					return yield* ComputersApi.ComputerConflict.make({
						version: computer.version,
					})
				if (
					computer.source._tag === "Connector" &&
					input.pauseAfter !== undefined &&
					input.pauseAfter !== null
				)
					return yield* ComputersApi.ComputerInvalid.make({
						message: "A connected machine cannot pause.",
					})
				const now = yield* Clock.currentTimeMillis
				const changed = yield* stored(
					db
						.update(computers)
						.set({
							...(input.name === undefined ? {} : { name: input.name }),
							...(input.pauseAfter === undefined
								? {}
								: { pauseAfter: input.pauseAfter }),
							version: computer.version + 1,
							updatedAt: now,
						})
						.where(
							and(
								where(caller.organizationId, id),
								eq(computers.version, computer.version),
							),
						)
						.returning(),
				)
				const next = changed[0]
				if (next === undefined)
					return yield* ComputersApi.ComputerConflict.make({
						version: computer.version,
					})
				return yield* fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "write")
				// A Computer with no sandbox, or one that the provider lost, has nothing to
				// delete there. Any other failure, such as a provider that OpenBot cannot
				// reach, stops the delete. Else the sandbox would stay at the provider,
				// and no Computer would point to it.
				const machine = yield* machineOf(current).pipe(
					Effect.asSome,
					Effect.catchTag("ComputerNotReady", () => Effect.succeedNone),
				)
				if (Option.isSome(machine)) yield* work(machine.value.destroy)
				yield* setState(caller.organizationId, id, "offline")
				yield* stored(
					db.delete(computers).where(where(caller.organizationId, id)),
				)
			}),
		pause: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "use")
				const machine = yield* machineOf(current)
				if (machine.pausable === undefined)
					return yield* ComputersApi.ComputerUnsupported.make({
						feature: "pause",
					})
				if (current.state === "running") {
					yield* work(machine.pausable.pause)
					yield* setState(caller.organizationId, id, "paused")
				}
				return yield* reread(caller.organizationId, id)
			}),
		resume: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "use")
				const machine = yield* machineOf(current)
				if (current.state === "paused" && machine.pausable !== undefined) {
					yield* resumeStored(caller.organizationId, id, machine.pausable)
				}
				return yield* reread(caller.organizationId, id)
			}),
		machine: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "use")
				if (current.state === "failed" || current.state === "offline")
					return yield* ComputersApi.ComputerNotReady.make({
						state: current.state,
					})
				const machine = yield* machineOf(current)
				if (current.state === "paused" && machine.pausable !== undefined) {
					yield* resumeStored(caller.organizationId, id, machine.pausable)
				} else yield* markActive(caller.organizationId, id)
				const computer = yield* reread(caller.organizationId, id)
				return {
					computer,
					machine: keepActive(caller.organizationId, id, machine),
				}
			}),
		work,
		setConnectorToken: (caller, id) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "write")
				if (computer.source._tag !== "Connector")
					return yield* ComputersApi.ComputerInvalid.make({
						message: "Only a connector Computer has a token.",
					})
				const token = yield* newToken(crypto)
				const tokenHash = yield* hashToken(crypto, token)
				yield* stored(
					db
						.update(computers)
						.set({ tokenHash })
						.where(where(caller.organizationId, id)),
				)
				// The old connection used the old token, so it must go.
				yield* connectors.close(id)
				return token
			}),
		byToken: (token) =>
			Effect.flatMap(hashToken(crypto, token), (tokenHash) =>
				stored(
					db
						.select({
							organizationId: computers.organizationId,
							id: computers.id,
						})
						.from(computers)
						.where(eq(computers.tokenHash, tokenHash)),
				),
			).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
		connected: (organizationId, id, hello) =>
			Effect.gen(function* () {
				const current = yield* row(organizationId, id)
				if (Option.isNone(current)) return
				if (Option.isSome(hello)) {
					const features = yield* fromStore(
						decodeFeatures(current.value.features),
					)
					yield* stored(
						db
							.update(computers)
							.set({
								features: yield* encodeFeatures({
									...features,
									desktop: hello.value.desktop,
								}),
							})
							.where(where(organizationId, id)),
					)
				}
				yield* setState(
					organizationId,
					id,
					Option.isSome(hello) ? "running" : "offline",
				)
			}).pipe(Effect.ignore),
		pair: (caller, input) =>
			Effect.gen(function* () {
				const token = yield* newToken(crypto)
				const tokenHash = yield* hashToken(crypto, token)
				const existing = (yield* stored(
					db
						.select()
						.from(computers)
						.where(
							and(
								eq(computers.organizationId, caller.organizationId),
								eq(computers.machineId, input.machineId),
							),
						),
				))[0]
				if (existing !== undefined) {
					// The person must be able to change the Computer to give it a new token.
					yield* access(caller, existing.id, "write")
					yield* stored(
						db
							.update(computers)
							.set({ tokenHash })
							.where(where(caller.organizationId, existing.id)),
					)
					yield* connectors.close(existing.id)
					return { computer: yield* fromRow(existing), token }
				}
				yield* mayCreate(caller, input.shared)
				const now = yield* Clock.currentTimeMillis
				const id = yield* newId
				yield* insert({
					organizationId: caller.organizationId,
					id,
					ownerUserId: input.shared ? null : caller.userId,
					name: input.name,
					source: "connector",
					machineId: input.machineId,
					tokenHash,
					state: "offline",
					features: yield* encodeFeatures({
						pause: false,
						desktop: input.desktop,
						ports: false,
					}),
					pauseAfter: null,
					createdBy: caller.userId,
					version: 0,
					createdAt: now,
					updatedAt: now,
					lastActiveAt: null,
				})
				return { computer: yield* reread(caller.organizationId, id), token }
			}),
		bots: (caller, id) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "read")
				const rows = yield* stored(
					db
						.select()
						.from(computerAccess)
						.where(
							and(
								eq(computerAccess.organizationId, caller.organizationId),
								eq(computerAccess.computerId, id),
							),
						)
						.orderBy(computerAccess.grantedAt),
				)
				return yield* fromStore(
					Effect.forEach(rows, (entry) =>
						Effect.map(decodeBot(entry.bot), (bot) => ({
							computer: computer.id,
							bot,
							grantedBy: entry.grantedBy,
							grantedAt: entry.grantedAt,
						})),
					),
				)
			}),
		grant: (caller, id, bot) =>
			Effect.gen(function* () {
				yield* access(caller, id, "use")
				const target = yield* botsService.access(caller, bot, "write").pipe(
					Effect.catchTags({
						BotNotFound: () =>
							ComputersApi.ComputerInvalid.make({
								message: "The Bot does not exist.",
							}),
						BotStorageUnavailable: () =>
							Effect.fail(ComputersApi.ComputersUnavailable.make({})),
						BotConflict: () =>
							ComputersApi.ComputerInvalid.make({
								message: "The Bot changed. Try again.",
							}),
						BotInvalid: (error) =>
							ComputersApi.ComputerInvalid.make({ message: error.message }),
					}),
				)
				if (target.archived)
					return yield* ComputersApi.ComputerInvalid.make({
						message: "An archived Bot cannot use a Computer.",
					})
				return yield* grantRow(caller.organizationId, id, bot, caller.userId)
			}),
		revoke: (caller, id, bot) =>
			Effect.gen(function* () {
				yield* access(caller, id, "use")
				yield* stored(
					db
						.delete(computerAccess)
						.where(
							and(
								eq(computerAccess.organizationId, caller.organizationId),
								eq(computerAccess.computerId, id),
								eq(computerAccess.bot, bot),
							),
						),
				)
			}),
		release: (organizationId, bot, id) =>
			stored(
				db
					.delete(computerAccess)
					.where(
						and(
							eq(computerAccess.organizationId, organizationId),
							eq(computerAccess.computerId, id),
							eq(computerAccess.bot, bot),
						),
					),
			).pipe(Effect.asVoid),
		grantApproved: grantRow,
		holds: (organizationId, bot, id) =>
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
				const found = yield* botOf(organizationId, bot)
				return Option.isSome(found) && !found.value.archived
			}),
		heldBy: (organizationId, bot) =>
			Effect.gen(function* () {
				const rows = yield* stored(
					db
						.select({ computer: computers })
						.from(computerAccess)
						.innerJoin(
							computers,
							and(
								eq(computers.organizationId, computerAccess.organizationId),
								eq(computers.id, computerAccess.computerId),
							),
						)
						.where(
							and(
								eq(computerAccess.organizationId, organizationId),
								eq(computerAccess.bot, bot),
							),
						)
						.orderBy(computers.createdAt),
				)
				return yield* Effect.forEach(rows, (entry) => fromRow(entry.computer))
			}),
		usage: (caller, id) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "read")
				const now = yield* Clock.currentTimeMillis
				const rows = yield* stored(
					db
						.select()
						.from(computerUsage)
						.where(
							and(
								eq(computerUsage.organizationId, caller.organizationId),
								eq(computerUsage.computerId, id),
							),
						)
						.orderBy(desc(computerUsage.startedAt))
						.limit(500),
				)
				return Arr.map(rows, (entry) => ({
					computer: computer.id,
					startedAt: entry.startedAt,
					endedAt: entry.endedAt,
					seconds: Math.round(
						((entry.endedAt ?? now) - entry.startedAt) / 1000,
					),
				}))
			}),
		pauseIdle: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const running = yield* stored(
				db
					.select()
					.from(computers)
					.where(
						and(
							eq(computers.state, "running"),
							eq(computers.source, "provider"),
						),
					),
			)
			for (const current of running) {
				if (!idle(current, now)) continue
				yield* Effect.gen(function* () {
					// The pauses of earlier Computers take time, so the first read can be old.
					const fresh = yield* row(current.organizationId, current.id)
					if (Option.isNone(fresh) || fresh.value.state !== "running") return
					if (!idle(fresh.value, yield* Clock.currentTimeMillis)) return
					const machine = yield* machineOf(fresh.value)
					if (machine.pausable === undefined) return
					yield* work(machine.pausable.pause)
					yield* setState(current.organizationId, current.id, "paused")
				}).pipe(
					Background.logFailure("OpenBot could not pause an idle Computer"),
					Effect.annotateLogs({
						computer: current.id,
						organization: current.organizationId,
					}),
				)
			}
		}).pipe(Effect.ignore),
		forgetArchived: Effect.gen(function* () {
			const rows = yield* stored(
				db
					.selectDistinct({
						organizationId: computerAccess.organizationId,
						bot: computerAccess.bot,
					})
					.from(computerAccess),
			)
			for (const entry of rows) {
				const found = yield* botOf(entry.organizationId, entry.bot)
				if (Option.isSome(found) && !found.value.archived) continue
				yield* stored(
					db
						.delete(computerAccess)
						.where(
							and(
								eq(computerAccess.organizationId, entry.organizationId),
								eq(computerAccess.bot, entry.bot),
							),
						),
				)
			}
		}).pipe(Effect.ignore),
	}
	return Computers.of(service)
})
export const layer = Layer.effect(Computers, make)
