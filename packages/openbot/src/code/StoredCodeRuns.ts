// These are plain query functions that take the database first. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { createHash } from "node:crypto"
import {
	CodeRunsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { and, eq, isNull, lt, or } from "drizzle-orm"
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"
import { Effect, Option, Schema } from "effect"
import { codeRuns } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"

/** One App call as the host keeps it. The hash of the arguments finds a program that changed. */
export const StoredCall = Schema.Struct({
	...CodeRunsApi.CodeCall.fields,
	argumentsHash: Schema.String,
})
export type StoredCall = typeof StoredCall.Type

/** A program as the host keeps it. */
export const Run = Schema.Struct({
	...CodeRunsApi.CodeRun.fields,
	calls: Schema.Array(StoredCall),
	/** Starts the random numbers of the program, so each run gets the same ones. */
	seed: Schema.Int,
	/** The time that the program sees, in milliseconds. It is the time of the first run. */
	clock: Schema.Finite,
	/** The member that the Agent works for. A host that takes over the run needs it. */
	organizationId: Schema.String,
	userId: Schema.String,
})
export type Run = typeof Run.Type

export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | SessionConflict
export const unavailable = () => ExperienceStorageUnavailable.make({})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
export const failure = (error: unknown) =>
	error instanceof SessionConflict || error instanceof ExperienceNotFound
		? error
		: unavailable()
/** Reads only find nothing or fail to reach the database. */
export type ReadError = ExperienceNotFound | ExperienceStorageUnavailable
const readFailure = (error: unknown): ReadError =>
	error instanceof ExperienceNotFound ? error : unavailable()
const notFound = () => ExperienceNotFound.make({ id: "Code run" })
const conflict = () =>
	SessionConflict.make({
		message: "The code run changed. Read it again before you continue.",
	})
const codec = Schema.fromJsonString(Run)
type Sealer = typeof Secrets.Service

/** The id of the program of one tool call. The same call always gets the same id. */
export const idOf = (input: {
	readonly owner: string
	readonly session: string
	readonly turn: string
	readonly callId: string
}) =>
	createHash("sha256")
		.update(
			JSON.stringify([input.owner, input.session, input.turn, input.callId]),
		)
		.digest("hex")

/** The API form of a run. It leaves out what only the host needs. */
export const view = (run: Run): CodeRunsApi.CodeRun => ({
	id: run.id,
	session: run.session,
	turn: run.turn,
	callId: run.callId,
	status: run.status,
	code: run.code,
	reason: run.reason,
	calls: run.calls.map(({ argumentsHash: _, ...call }) => call),
	result: run.result,
	createdAt: run.createdAt,
	updatedAt: run.updatedAt,
})

const binding = (owner: string, id: string) =>
	JSON.stringify(["code-run", owner, id])
const where = (owner: string, id: string) =>
	and(eq(codeRuns.owner, owner), eq(codeRuns.id, id))
const seal = (secrets: Sealer, owner: string, value: Run) =>
	Schema.encodeEffect(codec)(value).pipe(
		Effect.flatMap((body) => secrets.seal(body, binding(owner, value.id))),
	)
const open = (secrets: Sealer, row: typeof codeRuns.$inferSelect) =>
	secrets
		.open(row.body, binding(row.owner, row.id))
		.pipe(Effect.flatMap(Schema.decodeEffect(codec)))

export const get = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	id: string,
): Effect.Effect<Run, ReadError> =>
	Effect.gen(function* () {
		const row = (yield* db.select().from(codeRuns).where(where(owner, id)))[0]
		if (row === undefined) return yield* notFound()
		return yield* open(secrets, row)
	}).pipe(Effect.mapError(readFailure))

export const list = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	session: string,
): Effect.Effect<ReadonlyArray<Run>, ReadError> =>
	db
		.select()
		.from(codeRuns)
		.where(and(eq(codeRuns.owner, owner), eq(codeRuns.session, session)))
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => open(secrets, row)),
			),
			Effect.map((runs) => runs.toSorted((a, b) => a.createdAt - b.createdAt)),
			Effect.mapError(unavailable),
		)

/** The program of a tool call in a Session, if the call is a Code Mode call. */
export const forCall = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	session: string,
	callId: string,
): Effect.Effect<Option.Option<Run>, ReadError> =>
	db
		.select()
		.from(codeRuns)
		.where(
			and(
				eq(codeRuns.owner, owner),
				eq(codeRuns.session, session),
				eq(codeRuns.callId, callId),
			),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined
					? Effect.succeedNone
					: Effect.asSome(open(secrets, rows[0])),
			),
			Effect.mapError(unavailable),
		)

/**
 * Saves a new run. When the run already exists, it answers the stored one, so
 * the same tool call never makes two programs.
 */
export const insert = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	value: Run,
	leaseUntil: number,
): Effect.Effect<{ readonly run: Run; readonly created: boolean }, Error> =>
	Effect.gen(function* () {
		const body = yield* seal(secrets, owner, value)
		const inserted = yield* db
			.insert(codeRuns)
			.values({
				owner,
				id: value.id,
				session: value.session,
				callId: value.callId,
				status: value.status,
				leaseUntil,
				body,
			})
			.onConflictDoNothing()
			.returning({ id: codeRuns.id })
		if (inserted.length > 0) return { run: value, created: true }
		return { run: yield* get(db, secrets, owner, value.id), created: false }
	}).pipe(Effect.mapError(failure))

/**
 * Changes a run under a row lock. `update` gets the current run and its lease, and
 * answers the new run with its new lease, or none to leave the row as it is.
 */
export const change = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	id: string,
	update: (
		current: Run,
		leaseUntil: number | null,
	) => Option.Option<{ readonly run: Run; readonly leaseUntil: number | null }>,
): Effect.Effect<Option.Option<Run>, Error> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const row = (yield* tx
					.select()
					.from(codeRuns)
					.where(where(owner, id))
					.for("update"))[0]
				if (row === undefined) return yield* notFound()
				const next = update(yield* open(secrets, row), row.leaseUntil)
				if (Option.isNone(next)) return Option.none()
				const body = yield* seal(secrets, owner, next.value.run)
				const changed = yield* tx
					.update(codeRuns)
					.set({
						status: next.value.run.status,
						leaseUntil: next.value.leaseUntil,
						body,
					})
					.where(where(owner, id))
					.returning({ id: codeRuns.id })
				if (changed.length === 0) return yield* conflict()
				return Option.some(next.value.run)
			}),
		)
		.pipe(Effect.mapError(failure))

/** Runs whose host stopped while it ran them. Another host may take them over. */
export const stale = (
	db: EffectPgDatabase,
	now: number,
): Effect.Effect<
	ReadonlyArray<{
		readonly owner: string
		readonly id: string
		readonly session: string
	}>,
	Error
> =>
	db
		.select({
			owner: codeRuns.owner,
			id: codeRuns.id,
			session: codeRuns.session,
		})
		.from(codeRuns)
		.where(
			and(
				eq(codeRuns.status, "Running"),
				or(isNull(codeRuns.leaseUntil), lt(codeRuns.leaseUntil, now)),
			),
		)
		.pipe(Effect.mapError(unavailable))
