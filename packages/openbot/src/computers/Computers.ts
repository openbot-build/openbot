import { Lifecycle } from "./Lifecycle.ts"
import * as Activity from "./Activity.ts"
import { Directory } from "../resources/Directory.ts"
import { Computers as ComputerData, Execution } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import { type Caller, type ExecutionIdentity } from "@openbot-build/domain"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import {
	Array as Arr,
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
import { SqlClient } from "effect/sql"
import { Base64, Base64Url, Hex } from "effect/encoding"
import * as Background from "../execution/Background.ts"
import * as Failures from "../errors/Failures.ts"
import { Bots } from "../bots/Bots.ts"
import * as Check from "../authorization/Check.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { computerAccess, computers, computerUsage } from "../database/Schema.ts"
import {
	ComputerCallFailed,
	ComputerGone,
	type ComputerError,
	Machine,
} from "./Computer.ts"
import { ComputerProviders } from "./ComputerProviders.ts"
import * as ConnectorMachine from "./connector/ConnectorMachine.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"
import * as Access from "./Access.ts"

const decodeId = Schema.decodeUnknownEffect(ComputerData.ComputerId)
const decodeSource = Schema.decodeUnknownEffect(ComputerData.ComputerSource)
const decodeBot = Schema.decodeUnknownEffect(BotsApi.BotId)
/** The state column holds one of the states of the API. */
const decodeState = Schema.decodeUnknownEffect(ComputerData.ComputerState)

/** The features column holds JSON that only this file writes. */
const FeaturesJson = Schema.fromJsonString(ComputerData.ComputerFeatures)
const decodeFeatures = Schema.decodeUnknownEffect(FeaturesJson)
/** The features are values of the API type, so they always encode. */
const encodeFeatures = (features: ComputerData.ComputerFeatures) =>
	Schema.encodeEffect(FeaturesJson)(features).pipe(Effect.orDie)

/** A stored value that does not decode means a broken store. The log keeps the cause. */
const fromStore = <A>(decoded: Effect.Effect<A, Schema.SchemaError>) =>
	decoded.pipe(
		Failures.replace("A stored Computer has a bad value", () =>
			ComputerData.ComputersUnavailable.make({}),
		),
	)

type Computer = ComputerData.Computer
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
	| ComputerData.ComputerProviderInUse
	| ComputerData.ComputerPathNotFound
	| ComputerData.ComputerNotFound
	| ComputerData.ComputerProviderNotFound
	| ComputerData.ComputerConflict
	| ComputerData.ComputerInvalid
	| ComputerData.ComputerUnsupported
	| ComputerData.ComputerNotReady
	| ComputerData.ComputerProviderFailed
	| ComputerData.ComputersUnavailable
	| Check.Errors

/** A Computer is idle this long before OpenBot pauses it, unless it says otherwise. */
export const defaultPauseAfter = 10 * 60

/**
 * A running command marks its Computer as active this often. It must be shorter
 * than the shortest `pauseAfter`, which is 60 seconds.
 */
const activeInterval = Duration.seconds(30)

const fromRow = (
	row: Row,
): Effect.Effect<Computer, ComputerData.ComputersUnavailable> =>
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
		? ComputerData.ComputerNotReady.make({ state: "offline" })
		: error.missingPath !== undefined
			? ComputerData.ComputerPathNotFound.make({ path: error.missingPath })
			: ComputerData.ComputerProviderFailed.make({ message: error.message })

/**
 * Checks a file before a driver or a connector gets it. Bad base64 is a bad
 * input of the caller, not a failure of the provider.
 */
export const checkFile = (
	file: ComputerData.FileContent,
): Effect.Effect<void, ComputerData.ComputerInvalid> =>
	file.encoding === "base64"
		? Base64.decode(file.content).pipe(
				Effect.fromResult,
				Effect.mapError((error) =>
					ComputerData.ComputerInvalid.make({
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
			identity: ExecutionIdentity,
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
			input: ComputerData.CreateComputerRequest,
			bot?: BotsApi.BotId,
		) => Effect.Effect<Computer, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: ComputerData.UpdateComputerRequest,
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
			identity: ExecutionIdentity,
			id: string,
		) => Effect.Effect<
			{ readonly computer: Computer; readonly machine: Machine },
			Failure
		>
		/** Maps an error of the machine to an error of the API. */
		readonly work: <A, E>(
			effect: Effect.Effect<A, E>,
		) => Effect.Effect<A, Failure | Exclude<E, Extract<E, ComputerError>>>
		readonly setConnectorToken: (
			caller: Caller,
			id: string,
		) => Effect.Effect<string, Failure>
		/** The connector Computer that a token opens. */
		readonly byToken: (
			token: string,
		) => Effect.Effect<
			Option.Option<{ readonly organizationId: string; readonly id: string }>,
			ComputerData.ComputersUnavailable
		>
		/** Marks a connector Computer as connected or not. */
		readonly connected: (
			organizationId: string,
			id: string,
			hello: Option.Option<ComputerData.ConnectorHello>,
		) => Effect.Effect<void, ComputerData.ComputersUnavailable>
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
		) => Effect.Effect<ReadonlyArray<ComputerData.ComputerAccess>, Failure>
		/** Gives a Bot the right to use a Computer. The caller decides for the Bot. */
		readonly grant: (
			caller: Caller,
			id: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<ComputerData.ComputerAccess, Failure>
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
		) => Effect.Effect<void, ComputerData.ComputersUnavailable>
		/** Gives a Bot the right after its request was approved. It checks no permission. */
		readonly grantApproved: (
			organizationId: string,
			id: string,
			bot: BotsApi.BotId,
			grantedBy: string,
		) => Effect.Effect<
			ComputerData.ComputerAccess,
			ComputerData.ComputersUnavailable
		>
		/** True when the Bot has the right to use the Computer and is not archived. */
		readonly holds: (
			organizationId: string,
			bot: BotsApi.BotId,
			id: string,
		) => Effect.Effect<boolean, ComputerData.ComputersUnavailable>
		readonly usage: (
			caller: Caller,
			id: string,
		) => Effect.Effect<ReadonlyArray<ComputerData.ComputerUsage>, Failure>
	}
>()("@openbot-build/openbot/computers/Computers") {}

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const providers = yield* ComputerProviders
	const drivers = yield* Drivers
	const connectors = yield* Connectors
	const botsService = yield* Bots
	const crypto = yield* Crypto.Crypto
	const checks = yield* Check.make
	const { check } = checks
	const rights = yield* Access.make
	const directory = yield* Directory
	const lifecycle = yield* Lifecycle
	const activity = yield* Activity.make
	const pendingView = (row: Row) =>
		Effect.gen(function* () {
			const pending = yield* stored(activity.active(row.organizationId, row.id))
			return {
				...(yield* fromRow(row)),
				...(Option.isSome(pending)
					? { executionId: Execution.Id.make(pending.value.id) }
					: {}),
			}
		})
	const newId = crypto.randomBytes(16).pipe(
		Effect.map((bytes) => "cmp_" + Hex.encode(bytes)),
		Effect.orDie,
	)
	const stored = Failures.replace("The Computer store failed", () =>
		ComputerData.ComputersUnavailable.make({}),
	)
	const view = (row: Row) =>
		Effect.gen(function* () {
			if (row.source === "connector" && row.state === "running") {
				const address = yield* stored(
					directory.find({
						namespace: row.organizationId,
						kind: "computer-connector",
						id: row.id,
					}),
				)
				if (Option.isNone(address))
					return yield* pendingView({ ...row, state: "offline" })
			}
			return yield* pendingView(row)
		})
	const views = (organizationId: string, rows: ReadonlyArray<Row>) =>
		Effect.gen(function* () {
			if (
				!Arr.some(
					rows,
					(row) => row.source === "connector" && row.state === "running",
				)
			)
				return yield* Effect.forEach(rows, pendingView)
			const live = yield* stored(
				directory.list({
					namespace: organizationId,
					kind: "computer-connector",
				}),
			)
			return yield* Effect.forEach(rows, (row) =>
				pendingView(
					row.source === "connector" &&
						row.state === "running" &&
						!Arr.some(live, (address) => address.id === row.id)
						? { ...row, state: "offline" }
						: row,
				),
			)
		})

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
				return yield* ComputerData.ComputerNotFound.make({ id })
			return yield* view(found.value)
		})
	/** Marks a Computer as active now, so the worker does not pause it. */
	const markActive = (organizationId: string, id: string) =>
		activity
			.mark(organizationId, id)
			.pipe(
				Effect.catchTag("ExecutionStorageError", (error) =>
					stored(Effect.fail(error)),
				),
			)
	const runCommand = (
		identity: ExecutionIdentity,
		action: Parameters<Lifecycle["Service"]["execute"]>[1],
	) =>
		lifecycle.execute(identity, action).pipe(
			Effect.catchTags({
				ExecutionStorageError: (error) => stored(Effect.fail(error)),
				ExecutionForbidden: () =>
					Effect.fail(
						ComputerData.ComputerInvalid.make({
							message: "This Computer action is not allowed.",
						}),
					),
				ExecutionNotFound: () =>
					Effect.fail(
						ComputerData.ComputerInvalid.make({
							message: "The Computer action could not be found.",
						}),
					),
				ExecutionConflict: (error) =>
					Effect.fail(
						ComputerData.ComputerConflict.make({
							version: 0,
							executionId: error.id,
						}),
					),
				ExecutionKeyConflict: () =>
					Effect.fail(
						ComputerData.ComputerInvalid.make({
							message: "The command key has another input.",
						}),
					),
				SchemaError: (error) => stored(Effect.fail(error)),
			}),
		)

	/** Decode only after the shared query has checked access. */
	const access = (caller: Caller, id: string, need: Need) =>
		Effect.gen(function* () {
			const row = yield* rights
				.get(caller, id, need)
				.pipe(
					Effect.catchTag("ComputerStorageError", (error) =>
						stored(Effect.fail(error)),
					),
				)
			return { row, computer: yield* view(row) }
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
		state: ComputerData.ComputerState,
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

	/** Maps machine errors and keeps their private cause for the outside boundary. */
	const work = <A, E>(effect: Effect.Effect<A, E>) =>
		effect.pipe(
			Effect.catchIf(
				(error): error is Extract<E, ComputerError> =>
					Schema.is(ComputerCallFailed)(error) ||
					Schema.is(ComputerGone)(error),
				(error) =>
					Effect.fail(error).pipe(
						Failures.replace("A Computer provider call failed", () =>
							fromDriver(error),
						),
					),
			),
		)

	/** Provider loading is also used by the idle worker. It never opens a connector. */
	const providerMachine = (current: Row) =>
		Effect.gen(function* () {
			if (current.providerId === null || current.ref === null)
				return yield* ComputerData.ComputerNotReady.make({ state: "failed" })
			const { credentials } = yield* providers.credentials(
				current.organizationId,
				current.providerId,
			)
			const provider = yield* drivers.make(credentials)
			return yield* work(provider.attach(current.ref))
		})

	const machineOf = (current: Row, identity: ExecutionIdentity) =>
		Effect.gen(function* () {
			if (current.source === "connector") {
				const features = yield* fromStore(decodeFeatures(current.features))
				return ConnectorMachine.make({
					identity,
					computerId: current.id,
					desktop: features.desktop,
					connectors,
					online: current.state === "running",
				})
			}
			return yield* providerMachine(current)
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
								yield* background.repeat(
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
			} satisfies ComputerData.ComputerAccess
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
		list: (identity, bot) =>
			Effect.gen(function* () {
				const { organizationId } = identity.owner
				const readable = yield* Check.executionFilter(checks, identity, {
					action: "read",
					kind: "Computer",
					within: ($) => $.eq("organizationId", organizationId),
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
												eq(computerAccess.organizationId, organizationId),
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
								eq(computers.organizationId, organizationId),
								readable,
								held === undefined ? undefined : inArray(computers.id, held),
							),
						)
						.orderBy(computers.createdAt),
				)
				return yield* views(organizationId, rows)
			}),
		get: (caller, id, need = "read") =>
			Effect.map(access(caller, id, need), (found) => found.computer),
		create: (caller, input, bot) =>
			runCommand(
				{
					owner: caller,
					actor: caller,
					...(bot === undefined ? {} : { botId: bot }),
				},
				{ _tag: "Create", request: input },
			).pipe(Effect.flatMap((id) => reread(caller.organizationId, id))),
		update: (caller, id, input) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "write")
				yield* activity
					.ready(caller.organizationId, id)
					.pipe(
						Effect.catchTag("EffectDrizzleQueryError", (error) =>
							stored(Effect.fail(error)),
						),
					)
				if (input.expectedVersion !== computer.version)
					return yield* ComputerData.ComputerConflict.make({
						version: computer.version,
					})
				if (
					computer.source._tag === "Connector" &&
					input.pauseAfter !== undefined &&
					input.pauseAfter !== null
				)
					return yield* ComputerData.ComputerInvalid.make({
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
					return yield* ComputerData.ComputerConflict.make({
						version: computer.version,
					})
				return yield* fromRow(next)
			}).pipe(
				sql.withTransaction,
				Effect.catchTag("SqlError", (error) => stored(Effect.fail(error))),
			),
		remove: (caller, id) =>
			runCommand({ owner: caller, actor: caller }, { _tag: "Remove", id }).pipe(
				Effect.asVoid,
			),
		pause: (caller, id) =>
			runCommand({ owner: caller, actor: caller }, { _tag: "Pause", id }).pipe(
				Effect.flatMap(() => reread(caller.organizationId, id)),
			),
		resume: (caller, id) =>
			runCommand({ owner: caller, actor: caller }, { _tag: "Resume", id }).pipe(
				Effect.flatMap(() => reread(caller.organizationId, id)),
			),
		machine: (identity, id) =>
			Effect.gen(function* () {
				const caller = identity.actor
				yield* rights.execution(identity, id, "use").pipe(
					Effect.catchTags({
						ComputerStorageError: (error) => stored(Effect.fail(error)),
						ExecutionForbidden: () =>
							Effect.fail(ComputerData.ComputerNotFound.make({ id })),
					}),
				)
				const { row: current } = yield* access(caller, id, "use")
				if (current.state === "failed" || current.state === "offline")
					return yield* ComputerData.ComputerNotReady.make({
						state: current.state,
					})
				yield* markActive(caller.organizationId, id)
				let machine = yield* machineOf(current, identity)
				if (
					current.source === "provider" &&
					(current.state === "paused" ||
						(yield* work(machine.state)) === "paused")
				) {
					yield* runCommand(identity, { _tag: "Resume", id })
					const latest = yield* row(caller.organizationId, id)
					if (Option.isNone(latest))
						return yield* ComputerData.ComputerNotFound.make({ id })
					machine = yield* machineOf(latest.value, identity)
				}
				yield* markActive(caller.organizationId, id)
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
					return yield* ComputerData.ComputerInvalid.make({
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
				yield* connectors.close(caller.organizationId, id)
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
			}),
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
					yield* connectors.close(caller.organizationId, existing.id)
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
							ComputerData.ComputerInvalid.make({
								message: "The Bot does not exist.",
							}),
						BotStorageUnavailable: () =>
							Effect.fail(ComputerData.ComputersUnavailable.make({})),
						BotConflict: () =>
							ComputerData.ComputerInvalid.make({
								message: "The Bot changed. Try again.",
							}),
						BotInvalid: (error) =>
							ComputerData.ComputerInvalid.make({ message: error.message }),
					}),
				)
				if (target.archived)
					return yield* ComputerData.ComputerInvalid.make({
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
			stored(rights.holds(organizationId, bot, id)),
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
	}
	return Computers.of(service)
})
export const layer = Layer.effect(Computers, make)
