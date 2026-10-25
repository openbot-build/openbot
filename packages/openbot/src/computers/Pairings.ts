import {
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto"
import { type Caller, ComputersApi } from "@openbot-build/api"
import { and, count, eq, gt, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import { computerPairings } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { Computers, type Failure } from "./Computers.ts"

/** A pairing code works this long. */
export const lifetimeMs = 10 * 60 * 1000
/** The machine polls this often, in seconds. */
export const pollInterval = 3
/** At most this many pairings wait at the same time, in the whole deployment. */
export const openLimit = 1000

/** Letters and digits that people do not mix up, such as no `O` and `0`. */
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/** A code like `KDTW-7Q3M`. */
const newCode = () => {
	let code = ""
	for (let index = 0; index < 8; index++)
		code += alphabet[randomInt(alphabet.length)]
	return code.slice(0, 4) + "-" + code.slice(4)
}

/** People may type the code in small letters or without the dash. */
export const normalize = (code: string) =>
	code.toUpperCase().replaceAll(/[^A-Z0-9]/g, "")

const binding = (id: string) => `openbot_computer_pairings:${id}:token`

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
			Failure | ComputersApi.PairingInvalid,
			AuthorizationServices
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
	const secrets = yield* Secrets
	const computers = yield* Computers
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.mapError(() => ComputersApi.ComputersUnavailable.make({})),
		)
	/** A pairing that still waits for a person. */
	const waiting = (code: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const row = (yield* stored(
				db
					.select()
					.from(computerPairings)
					.where(eq(computerPairings.codeHash, sha(normalize(code)))),
			))[0]
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
				if ((open[0]?.value ?? 0) >= openLimit)
					return yield* ComputersApi.ComputersUnavailable.make({})
				const id = "cpa_" + randomBytes(16).toString("hex")
				const code = newCode()
				const secret = "ocp_" + randomBytes(32).toString("base64url")
				const expiresAt = now + lifetimeMs
				yield* stored(
					db.insert(computerPairings).values({
						id,
						codeHash: sha(normalize(code)),
						secretHash: sha(secret),
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
				const given = Buffer.from(sha(secret), "hex")
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
				const token = yield* stored(secrets.open(row.token, binding(id)))
				// The token goes out only once.
				yield* stored(
					db
						.update(computerPairings)
						.set({ status: "used", token: null })
						.where(eq(computerPairings.id, id)),
				)
				return {
					_tag: "Approved",
					computer: ComputersApi.ComputerId.make(row.computerId),
					token,
				} as const
			}),
		get: (code) =>
			Effect.map(waiting(code), (row) => ({
				code: code.toUpperCase(),
				hostname: row.hostname,
				os: row.os,
				arch: row.arch,
				desktop: row.desktop,
				expiresAt: row.expiresAt,
			})),
		approve: (caller, code, input) =>
			Effect.gen(function* () {
				const row = yield* waiting(code)
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
			}),
		deny: (code) =>
			Effect.gen(function* () {
				const row = yield* waiting(code)
				yield* stored(
					db
						.update(computerPairings)
						.set({ status: "denied" })
						.where(eq(computerPairings.id, row.id)),
				)
			}),
		removeOld: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			// An approved token that nobody took for a day is not needed any more.
			yield* db
				.delete(computerPairings)
				.where(lt(computerPairings.expiresAt, now - 24 * 60 * 60 * 1000))
		}).pipe(Effect.ignore),
	})
})
export const layer = Layer.effect(Pairings, make)
