// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API to compare secrets in constant time.
import { timingSafeEqual } from "node:crypto"
import { type Caller, ComputersApi } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { and, count, eq, gt, lt } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Base64Url, Hex } from "effect/encoding"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import * as Db from "../database/Database.ts"
import { computerPairings } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { Computers, type Failure, hashToken } from "./Computers.ts"

/** A pairing code works this long. */
export const lifetimeMs = 10 * 60 * 1000
/** The machine polls this often, in seconds. */
export const pollInterval = 3
/** At most this many pairings wait at the same time, in the whole deployment. */
export const openLimit = 1000

/** Letters and digits that people do not mix up, such as no `O` and `0`. */
const alphabet = Str.split("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", "")

/** People may type the code in small letters or without the dash. */
export const normalize = (code: string) =>
	pipe(code, Str.toUpperCase, Str.replaceAll(/[^A-Z0-9]/g, ""))

const binding = (id: string) => `openbot_computer_pairings:${id}:token`

const decodeComputerId = Schema.decodeUnknownEffect(ComputersApi.ComputerId)

/**
 * Pairings of the machines of people. A machine starts one without a key. A person
 * approves its code. Then the machine takes its token once.
 */
export class Pairings extends Context.Service<
	Pairings,
	{
		readonly start: (
			input: ComputersApi.StartPairingRequest,
		) => Effect.Effect<
			ComputersApi.Pairing,
			ComputersApi.PairingInvalid | ComputersApi.ComputersUnavailable
		>
		readonly poll: (
			id: string,
			secret: string,
		) => Effect.Effect<
			ComputersApi.PairingStatus,
			ComputersApi.PairingInvalid | ComputersApi.ComputersUnavailable
		>
		readonly get: (
			code: string,
		) => Effect.Effect<
			ComputersApi.ComputerPairing,
			ComputersApi.PairingInvalid | ComputersApi.ComputersUnavailable
		>
		readonly approve: (
			caller: Caller,
			code: string,
			input: ComputersApi.ApprovePairingRequest,
		) => Effect.Effect<
			ComputersApi.Computer,
			Failure | ComputersApi.PairingInvalid
		>
		readonly deny: (
			code: string,
		) => Effect.Effect<
			void,
			ComputersApi.PairingInvalid | ComputersApi.ComputersUnavailable
		>
		/** Removes pairings that ended. */
		readonly removeOld: Effect.Effect<void>
	}
>()("@openbot-build/openbot/computers/Pairings") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets
	const computers = yield* Computers
	const crypto = yield* Crypto.Crypto
	const stored = Failures.replace("The pairing store failed", () =>
		ComputersApi.ComputersUnavailable.make({}),
	)
	// OpenBot needs secure random numbers and SHA-256 to run, so a failure here is a defect.
	const randomBytes = (size: number) =>
		crypto.randomBytes(size).pipe(Effect.orDie)
	const sha = (value: string) => hashToken(crypto, value)
	/** A code like `KDTW-7Q3M`. */
	const newCode = crypto
		.randomIntBetween(0, alphabet.length, { halfOpen: true })
		.pipe(
			Effect.replicateEffect(8),
			Effect.map((picks) =>
				pipe(
					picks,
					Arr.map((index) => Arr.getUnsafe(alphabet, index)),
					Arr.chunksOf(4),
					Arr.map(Arr.join("")),
					Arr.join("-"),
				),
			),
		)
	/**
	 * A pairing that still waits for a person. With `lock`, the row stays locked
	 * until the open transaction ends.
	 */
	const waiting = (code: string, lock = false) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const codeHash = yield* sha(normalize(code))
			const query = db
				.select()
				.from(computerPairings)
				.where(eq(computerPairings.codeHash, codeHash))
			const row = (yield* stored(lock ? query.for("update") : query))[0]
			if (row === undefined || row.status !== "waiting" || row.expiresAt <= now)
				return yield* ComputersApi.PairingInvalid.make({})
			return row
		})
	return Pairings.of({
		start: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const open = yield* stored(
					db
						.select({ value: count() })
						.from(computerPairings)
						.where(gt(computerPairings.expiresAt, now)),
				)
				// Starting needs no key, so a limit keeps the table small.
				const waitingNow = open[0]?.value ?? 0
				if (waitingNow >= openLimit) {
					yield* Effect.logWarning(
						"Too many Computer pairings wait at the same time.",
					).pipe(Effect.annotateLogs({ open: waitingNow, limit: openLimit }))
					return yield* ComputersApi.ComputersUnavailable.make({})
				}
				const id = "cpa_" + Hex.encode(yield* randomBytes(16))
				const code = yield* newCode
				const secret = "ocp_" + Base64Url.encode(yield* randomBytes(32))
				const expiresAt = now + lifetimeMs
				yield* stored(
					db.insert(computerPairings).values({
						id,
						codeHash: yield* sha(normalize(code)),
						secretHash: yield* sha(secret),
						machineId: input.machineId,
						hostname: input.hostname,
						os: input.os,
						arch: input.arch,
						desktop: input.desktop,
						version: String(input.version),
						status: "waiting",
						expiresAt,
						createdAt: now,
					}),
				)
				return {
					id: ComputersApi.PairingId.make(id),
					code,
					secret,
					interval: pollInterval,
					expiresAt,
				}
			}),
		poll: (id, secret) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = (yield* stored(
					db.select().from(computerPairings).where(eq(computerPairings.id, id)),
				))[0]
				if (row === undefined)
					return yield* ComputersApi.PairingInvalid.make({})
				const expected = Buffer.from(row.secretHash, "hex")
				const given = Buffer.from(yield* sha(secret), "hex")
				if (!timingSafeEqual(expected, given))
					return yield* ComputersApi.PairingInvalid.make({})
				if (row.status === "waiting" && row.expiresAt > now)
					return { _tag: "Pending" } as const
				if (
					row.status !== "approved" ||
					row.token === null ||
					row.computerId === null
				)
					return yield* ComputersApi.PairingInvalid.make({})
				// A bad stored ID fails here, before the token goes out.
				const computer = yield* stored(decodeComputerId(row.computerId))
				const token = yield* stored(secrets.open(row.token, binding(id)))
				// The token goes out only once, so only the poll that marks the pairing used gives it.
				const claimed = yield* stored(
					db
						.update(computerPairings)
						.set({ status: "used", token: null })
						.where(
							and(
								eq(computerPairings.id, id),
								eq(computerPairings.status, "approved"),
							),
						)
						.returning({ id: computerPairings.id }),
				)
				if (claimed.length === 0)
					return yield* ComputersApi.PairingInvalid.make({})
				return {
					_tag: "Approved",
					computer,
					token,
				} as const
			}),
		get: (code) =>
			Effect.map(waiting(code), (row) => ({
				code: Str.toUpperCase(code),
				hostname: row.hostname,
				os: row.os,
				arch: row.arch,
				desktop: row.desktop,
				expiresAt: row.expiresAt,
			})),
		// The lock makes a second approval of the same code wait, and then it sees
		// that the pairing does not wait any more. So only one pair gives a token.
		approve: (caller, code, input) =>
			Effect.gen(function* () {
				const row = yield* waiting(code, true)
				const { computer, token } = yield* computers.pair(caller, {
					machineId: row.machineId,
					name: input.name ?? row.hostname,
					shared: input.shared === true,
					desktop: row.desktop,
				})
				const sealed = yield* stored(secrets.seal(token, binding(row.id)))
				yield* stored(
					db
						.update(computerPairings)
						.set({
							status: "approved",
							organizationId: caller.organizationId,
							computerId: computer.id,
							token: sealed,
						})
						.where(
							and(
								eq(computerPairings.id, row.id),
								eq(computerPairings.status, "waiting"),
							),
						),
				)
				return computer
			}).pipe(
				sql.withTransaction,
				Failures.replaceTag("SqlError", "The pairing transaction failed", () =>
					ComputersApi.ComputersUnavailable.make({}),
				),
			),
		deny: (code) =>
			Effect.gen(function* () {
				const row = yield* waiting(code)
				// An approval may come between the read and this update. It wins.
				const denied = yield* stored(
					db
						.update(computerPairings)
						.set({ status: "denied" })
						.where(
							and(
								eq(computerPairings.id, row.id),
								eq(computerPairings.status, "waiting"),
							),
						)
						.returning({ id: computerPairings.id }),
				)
				if (denied.length === 0)
					return yield* ComputersApi.PairingInvalid.make({})
			}),
		removeOld: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			// An approved token that nobody took for a day is not needed any more.
			yield* db
				.delete(computerPairings)
				.where(lt(computerPairings.expiresAt, now - 24 * 60 * 60 * 1000))
		}).pipe(
			Background.logFailure("OpenBot could not remove old Computer pairings"),
		),
	})
})
export const layer = Layer.effect(Pairings, make)
