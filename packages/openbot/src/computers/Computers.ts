import { createHash, randomBytes } from "node:crypto"
import { BotsApi, type Caller, ComputersApi } from "@openbot-build/api"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Bots } from "../bots/Bots.ts"
import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import {
	type Errors as CheckErrors,
	check,
	filter,
	guard,
} from "../authorization/Check.ts"
import { computerResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { computerAccess, computers, computerUsage } from "../database/Schema.ts"
import type { ComputerError, Machine } from "./Computer.ts"
import { ComputerProviders, unavailable } from "./ComputerProviders.ts"
import * as ConnectorMachine from "./connector/ConnectorMachine.ts"
import { Connectors } from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"

/** The state column holds one of the states of the API. */
const decodeState = Schema.decodeUnknownSync(ComputersApi.ComputerState)

/** The features column holds JSON that only this file writes. */
const decodeFeatures = Schema.decodeUnknownSync(
	Schema.fromJsonString(ComputersApi.ComputerFeatures),
)

type Computer = ComputersApi.Computer
type Row = typeof computers.$inferSelect

const notFound = (id: string) => ComputersApi.ComputerNotFound.make({ id })
const invalid = (message: string) =>
	ComputersApi.ComputerInvalid.make({ message })

export const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("hex")

/** A new connector token. Only its hash is stored. */
export const newToken = () => "oct_" + randomBytes(32).toString("base64url")

export type Failure =
	| ComputersApi.ComputerNotFound
	| ComputersApi.ComputerProviderNotFound
	| ComputersApi.ComputerConflict
	| ComputersApi.ComputerInvalid
	| ComputersApi.ComputerUnsupported
	| ComputersApi.ComputerNotReady
	| ComputersApi.ComputerProviderFailed
	| ComputersApi.ComputersUnavailable
	| CheckErrors

/** A Computer is idle this long before OpenBot pauses it, unless it says otherwise. */
export const defaultPauseAfter = 10 * 60

const fromRow = (row: Row): Computer => ({
	id: ComputersApi.ComputerId.make(row.id),
	name: row.name,
	owner:
		row.ownerUserId === null
			? { _tag: "Organization" }
			: { _tag: "Member", userId: row.ownerUserId },
	source:
		row.source === "connector"
			? { _tag: "Connector" }
			: {
					_tag: "Provider",
					provider: ComputersApi.ComputerProviderId.make(row.providerId ?? ""),
					template: row.template,
				},
	state: decodeState(row.state),
	features: decodeFeatures(row.features),
	pauseAfter: row.pauseAfter,
	createdBy: row.createdBy,
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	lastActiveAt: row.lastActiveAt,
})

/** Maps an error of a driver or a connector to an error of the API. */
const fromDriver = (error: ComputerError) =>
	error._tag === "ComputerGone"
		? ComputersApi.ComputerNotReady.make({ state: "offline" })
		: ComputersApi.ComputerProviderFailed.make({ message: error.message })

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
		) => Effect.Effect<ReadonlyArray<Computer>, Failure, AuthorizationServices>
		readonly get: (
			caller: Caller,
			id: string,
			need?: Need,
		) => Effect.Effect<Computer, Failure, AuthorizationServices>
		/**
		 * Creates a Computer. `createdBy` is the Bot that made it for the caller.
		 * That Bot gets the right to use it.
		 */
		readonly create: (
			caller: Caller,
			input: ComputersApi.CreateComputerRequest,
			bot?: BotsApi.BotId,
		) => Effect.Effect<Computer, Failure, AuthorizationServices>
		readonly update: (
			caller: Caller,
			id: string,
			input: ComputersApi.UpdateComputerRequest,
		) => Effect.Effect<Computer, Failure, AuthorizationServices>
		/** Deletes a Computer, its sandbox, and every right to use it. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure, AuthorizationServices>
		readonly pause: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Computer, Failure, AuthorizationServices>
		readonly resume: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Computer, Failure, AuthorizationServices>
		/**
		 * Reads a Computer that the caller may use, and gets its machine ready.
		 * A paused Computer resumes first. Work marks the Computer as active.
		 */
		readonly machine: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			{ readonly computer: Computer; readonly machine: Machine },
			Failure,
			AuthorizationServices
		>
		/** Maps an error of the machine to an error of the API. */
		readonly work: <A>(
			effect: Effect.Effect<A, ComputerError>,
		) => Effect.Effect<A, Failure>
		readonly setConnectorToken: (
			caller: Caller,
			id: string,
		) => Effect.Effect<string, Failure, AuthorizationServices>
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
			Failure,
			AuthorizationServices
		>
		readonly bots: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			ReadonlyArray<ComputersApi.ComputerAccess>,
			Failure,
			AuthorizationServices
		>
		/** Gives a Bot the right to use a Computer. The caller decides for the Bot. */
		readonly grant: (
			caller: Caller,
			id: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<
			ComputersApi.ComputerAccess,
			Failure,
			AuthorizationServices
		>
		readonly revoke: (
			caller: Caller,
			id: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<void, Failure, AuthorizationServices>
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
		) => Effect.Effect<
			ReadonlyArray<ComputersApi.ComputerUsage>,
			Failure,
			AuthorizationServices
		>
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
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const where = (organizationId: string, id: string) =>
		and(eq(computers.organizationId, organizationId), eq(computers.id, id))
	const row = (organizationId: string, id: string) =>
		stored(db.select().from(computers).where(where(organizationId, id))).pipe(
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
		)
	/** A caller who cannot read a Computer does not learn that it exists. */
	const access = (caller: Caller, id: string, need: Need) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found)) return yield* notFound(id)
			const computer = fromRow(found.value)
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
					hide: () => notFound(id),
				},
			)
			return { computer, row: found.value }
		})

	/** Changes the stored state, and opens or closes a usage record with it. */
	const setState = (
		organizationId: string,
		current: Row,
		state: ComputersApi.ComputerState,
	) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* stored(
				db
					.update(computers)
					.set({ state, updatedAt: now, lastActiveAt: now })
					.where(where(organizationId, current.id)),
			)
			const running = state === "running"
			const wasRunning = current.state === "running"
			if (running && !wasRunning)
				yield* stored(
					db.insert(computerUsage).values({
						organizationId,
						computerId: current.id,
						ownerUserId: current.ownerUserId,
						startedAt: now,
					}),
				)
			if (!running && wasRunning)
				yield* stored(
					db
						.update(computerUsage)
						.set({ endedAt: now })
						.where(
							and(
								eq(computerUsage.computerId, current.id),
								isNull(computerUsage.endedAt),
							),
						),
				)
		})

	/** The machine behind a stored Computer. */
	const machineOf = (current: Row) =>
		Effect.gen(function* () {
			if (current.source === "connector") {
				const features = decodeFeatures(current.features)
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
			return yield* provider
				.attach(current.ref)
				.pipe(Effect.mapError(fromDriver))
		})

	const work = <A>(effect: Effect.Effect<A, ComputerError>) =>
		effect.pipe(Effect.mapError(fromDriver))

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
					.onConflictDoNothing(),
			)
			const rows = yield* stored(
				db
					.select()
					.from(computerAccess)
					.where(
						and(
							eq(computerAccess.computerId, computerId),
							eq(computerAccess.bot, bot),
						),
					),
			)
			const saved = rows[0]!
			return {
				computer: ComputersApi.ComputerId.make(computerId),
				bot,
				grantedBy: saved.grantedBy,
				grantedAt: saved.grantedAt,
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
						: (yield* stored(
								db
									.select({ id: computerAccess.computerId })
									.from(computerAccess)
									.where(
										and(
											eq(computerAccess.organizationId, caller.organizationId),
											eq(computerAccess.bot, bot),
										),
									),
							)).map((entry) => entry.id)
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
				return rows.map(fromRow)
			}),
		get: (caller, id, need = "read") =>
			Effect.map(access(caller, id, need), (found) => found.computer),
		create: (caller, input, bot) =>
			Effect.gen(function* () {
				const shared = input.shared === true
				yield* mayCreate(caller, shared)
				const now = yield* Clock.currentTimeMillis
				const id = "cmp_" + randomBytes(16).toString("hex")
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
						features: JSON.stringify({
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
					const created = yield* driver
						.create({
							...(input.source.template === null
								? {}
								: { template: input.source.template }),
							desktop,
							labels: {
								openbot_computer: id,
								openbot_organization: caller.organizationId,
							},
						})
						.pipe(Effect.mapError(fromDriver))
					yield* insert({
						...base,
						source: "provider",
						providerId: provider.id,
						template: input.source.template,
						ref: created.ref,
						state: "starting",
						features: JSON.stringify({ pause: true, desktop, ports: true }),
					})
					const stored_ = Option.getOrThrow(
						yield* row(caller.organizationId, id),
					)
					yield* setState(caller.organizationId, stored_, "running")
				}
				if (bot !== undefined)
					yield* grantRow(caller.organizationId, id, bot, caller.userId)
				return fromRow(Option.getOrThrow(yield* row(caller.organizationId, id)))
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
					return yield* invalid("A connected machine cannot pause.")
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
				return fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "write")
				const machine = yield* machineOf(current).pipe(Effect.option)
				if (Option.isSome(machine))
					yield* machine.value.destroy.pipe(Effect.mapError(fromDriver))
				yield* setState(caller.organizationId, current, "offline")
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
					yield* setState(caller.organizationId, current, "paused")
				}
				return fromRow(Option.getOrThrow(yield* row(caller.organizationId, id)))
			}),
		resume: (caller, id) =>
			Effect.gen(function* () {
				const { row: current } = yield* access(caller, id, "use")
				const machine = yield* machineOf(current)
				if (current.state === "paused" && machine.pausable !== undefined) {
					yield* work(machine.pausable.resume)
					yield* setState(caller.organizationId, current, "running")
				}
				return fromRow(Option.getOrThrow(yield* row(caller.organizationId, id)))
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
					yield* work(machine.pausable.resume)
					yield* setState(caller.organizationId, current, "running")
				} else {
					const now = yield* Clock.currentTimeMillis
					yield* stored(
						db
							.update(computers)
							.set({ lastActiveAt: now })
							.where(where(caller.organizationId, id)),
					)
				}
				const computer = fromRow(
					Option.getOrThrow(yield* row(caller.organizationId, id)),
				)
				return { computer, machine }
			}),
		work,
		setConnectorToken: (caller, id) =>
			Effect.gen(function* () {
				const { computer } = yield* access(caller, id, "write")
				if (computer.source._tag !== "Connector")
					return yield* invalid("Only a connector Computer has a token.")
				const token = newToken()
				yield* stored(
					db
						.update(computers)
						.set({ tokenHash: hashToken(token) })
						.where(where(caller.organizationId, id)),
				)
				// The old connection used the old token, so it must go.
				yield* connectors.close(id)
				return token
			}),
		byToken: (token) =>
			stored(
				db
					.select({
						organizationId: computers.organizationId,
						id: computers.id,
					})
					.from(computers)
					.where(eq(computers.tokenHash, hashToken(token))),
			).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]))),
		connected: (organizationId, id, hello) =>
			Effect.gen(function* () {
				const current = yield* row(organizationId, id)
				if (Option.isNone(current)) return
				if (Option.isSome(hello)) {
					const features = decodeFeatures(current.value.features)
					yield* stored(
						db
							.update(computers)
							.set({
								features: JSON.stringify({
									...features,
									desktop: hello.value.desktop,
								}),
							})
							.where(where(organizationId, id)),
					)
				}
				yield* setState(
					organizationId,
					current.value,
					Option.isSome(hello) ? "running" : "offline",
				)
			}).pipe(Effect.ignore),
		pair: (caller, input) =>
			Effect.gen(function* () {
				const token = newToken()
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
							.set({ tokenHash: hashToken(token) })
							.where(where(caller.organizationId, existing.id)),
					)
					yield* connectors.close(existing.id)
					return { computer: fromRow(existing), token }
				}
				yield* mayCreate(caller, input.shared)
				const now = yield* Clock.currentTimeMillis
				const id = "cmp_" + randomBytes(16).toString("hex")
				yield* insert({
					organizationId: caller.organizationId,
					id,
					ownerUserId: input.shared ? null : caller.userId,
					name: input.name,
					source: "connector",
					machineId: input.machineId,
					tokenHash: hashToken(token),
					state: "offline",
					features: JSON.stringify({
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
				return {
					computer: fromRow(
						Option.getOrThrow(yield* row(caller.organizationId, id)),
					),
					token,
				}
			}),
		bots: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "read")
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
				return rows.map((entry) => ({
					computer: ComputersApi.ComputerId.make(entry.computerId),
					bot: BotsApi.BotId.make(entry.bot),
					grantedBy: entry.grantedBy,
					grantedAt: entry.grantedAt,
				}))
			}),
		grant: (caller, id, bot) =>
			Effect.gen(function* () {
				yield* access(caller, id, "use")
				const target = yield* botsService.access(caller, bot, "write").pipe(
					Effect.catchTags({
						BotNotFound: () => invalid("The Bot does not exist."),
						BotStorageUnavailable: () => Effect.fail(unavailable()),
						BotConflict: () => invalid("The Bot changed. Try again."),
						BotInvalid: (error) => invalid(error.message),
					}),
				)
				if (target.archived)
					return yield* invalid("An archived Bot cannot use a Computer.")
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
				const found = yield* botsService
					.find(organizationId, bot)
					.pipe(Effect.mapError(unavailable))
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
				return rows.map((entry) => fromRow(entry.computer))
			}),
		usage: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "read")
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
				return rows.map((entry) => ({
					computer: ComputersApi.ComputerId.make(entry.computerId),
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
				if (current.pauseAfter === null) continue
				const last = current.lastActiveAt ?? current.updatedAt
				if (now - last < current.pauseAfter * 1000) continue
				yield* Effect.gen(function* () {
					const machine = yield* machineOf(current)
					if (machine.pausable === undefined) return
					yield* work(machine.pausable.pause)
					yield* setState(current.organizationId, current, "paused")
				}).pipe(
					Effect.catch((error) =>
						Effect.logWarning("OpenBot could not pause an idle Computer.", {
							computer: current.id,
							error,
						}),
					),
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
				const found = yield* botsService
					.find(entry.organizationId, entry.bot)
					.pipe(Effect.mapError(unavailable))
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
