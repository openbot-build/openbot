import { type SecretStorageError, Secrets } from "../secrets/Secrets.ts"
import { Paused } from "./Admission.ts"
import {
	Caller,
	Execution,
	ExecutionIdentity,
	ServiceIdentity,
	WorkIdentity,
	type ServiceId,
	type ServiceCaller,
	type ServiceScope,
} from "@openbot-build/domain"
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	notInArray,
} from "drizzle-orm"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import {
	Array as Arr,
	Clock,
	Cause,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { SqlClient, SqlError } from "effect/sql"
import * as Db from "../database/Database.ts"
import {
	executions,
	executionEvents,
	executionCommands,
	executionOutbox,
	executionCalls,
	executionDecisions,
} from "../database/ExecutionSchema.ts"

export const Submission = Schema.Struct({
	workflow: Schema.String,
	ownerExecutionId: Schema.optionalKey(Execution.Id),
	resource: Execution.Resource,
	/** A resource may close admission and wait for the work linked to it. */
	context: Schema.optionalKey(Execution.Resource),
	identity: WorkIdentity,
	input: Schema.Json,
})
export type Submission = typeof Submission.Type
/** A command key belongs to a member account or a named service in one scope. */
export type CommandActor =
	| Pick<Caller, "organizationId" | "userId">
	| (ServiceCaller & {
			readonly scope: ServiceScope
	  })
export const commandActor = (identity: WorkIdentity): CommandActor =>
	Schema.is(ServiceIdentity)(identity)
		? { ...identity.actor, scope: identity.owner }
		: identity.actor
const commandOwner = (identity: WorkIdentity): CommandActor =>
	Schema.is(ExecutionIdentity)(identity)
		? identity.owner
		: commandActor(identity)
const principal = (actor: CommandActor) =>
	"scope" in actor
		? {
				principalKind: "service" as const,
				organizationId:
					actor.scope.kind === "organization"
						? actor.scope.organizationId
						: null,
				userId: null,
				serviceId: actor.serviceId,
			}
		: {
				principalKind: "member" as const,
				organizationId: actor.organizationId,
				userId: actor.userId,
				serviceId: null,
			}

export interface Key {
	readonly namespace: string
	readonly id: Execution.Id
}
export interface Fence extends Key {
	readonly generation: number
}
const json = Schema.fromJsonString(Schema.Json)
const sameJson = Schema.toEquivalence(Schema.Json)
const identityCodec = Schema.fromJsonString(WorkIdentity)
const eventCodec = Schema.fromJsonString(Execution.EventBody)
const failureCodec = Schema.fromJsonString(Execution.Failure)

const known = Schema.Union([
	Execution.NotFound,
	Execution.Conflict,
	Execution.KeyConflict,
	Execution.Forbidden,
	Execution.StorageError,
	Paused,
])
export const storage = <A, E, R>(work: Effect.Effect<A, E, R>) => {
	const isKnown = (error: E): error is Extract<E, typeof known.Type> =>
		Schema.is(known)(error)
	return work.pipe(
		Effect.catchCause(
			(
				cause,
			): Effect.Effect<
				never,
				Extract<E, typeof known.Type> | Execution.StorageError
			> => {
				if (Cause.hasInterruptsOnly(cause))
					return Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				const reason = cause.reasons[0]
				if (
					cause.reasons.length === 1 &&
					reason?._tag === "Fail" &&
					isKnown(reason.error)
				) {
					const error = reason.error
					return Effect.failCause(Cause.map(cause, () => error))
				}
				return Effect.fail(Execution.StorageError.make({ cause }))
			},
		),
	)
}

/** Keep all SQL causes. A domain failure from a transaction callback keeps its own type. */
export const transactionFailures = <A, E, R>(
	work: Effect.Effect<A, E, R>,
): Effect.Effect<
	A,
	| Exclude<E, SqlError.SqlError | EffectDrizzleQueryError>
	| Execution.StorageError,
	R
> => {
	const isDomain = (
		error: E,
	): error is Exclude<E, SqlError.SqlError | EffectDrizzleQueryError> =>
		!SqlError.isSqlError(error) && !Schema.is(EffectDrizzleQueryError)(error)
	return work.pipe(
		Effect.catchCause((cause) => {
			if (
				cause.reasons.length > 0 &&
				Arr.every(
					cause.reasons,
					(reason) => reason._tag === "Fail" && !isDomain(reason.error),
				)
			)
				return Effect.fail(Execution.StorageError.make({ cause }))
			return Effect.failCause(
				Cause.map(cause, (error) =>
					isDomain(error) ? error : Execution.StorageError.make({ cause }),
				),
			)
		}),
	)
}

export interface Loaded<I extends WorkIdentity = WorkIdentity> {
	record: Execution.Record
	workflow: string
	context: { kind: string; id: string } | null
	generation: number
	cancelEpoch: number
	cancelPending: boolean
	phaseFailed: boolean
	input: Schema.Json
	identity: I
}
export type MemberExecution = Loaded<ExecutionIdentity>
export type ServiceExecution = Loaded<ServiceIdentity>

export interface Service {
	readonly receipt: (
		namespace: string,
		commandKey: Execution.CommandKey,
		input: { readonly actor: CommandActor; readonly body: Schema.Json },
	) => Effect.Effect<
		Option.None<Execution.Receipt> | Option.Some<Execution.Receipt>,
		Execution.KeyConflict | Execution.StorageError
	>
	readonly accept: <E, R>(
		namespace: string,
		commandKey: Execution.CommandKey,
		input: { readonly actor: CommandActor; readonly body: Schema.Json },
		apply: (
			allocate: (
				input: Submission,
			) => Effect.Effect<
				{ namespace: string; id: Execution.Id },
				Execution.Conflict | Execution.Forbidden | Execution.StorageError
			>,
		) => Effect.Effect<
			{
				readonly executionId: Execution.Id
				readonly start: boolean
				readonly dispatch?: boolean
				readonly events?: ReadonlyArray<
					Exclude<Execution.EventBody, { readonly _tag: "State" }>
				>
			},
			E,
			R
		>,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
		| Exclude<E, EffectDrizzleQueryError | SqlError.SqlError>,
		R
	>
	readonly activate: (
		key: Key,
		events?: ReadonlyArray<
			Exclude<Execution.EventBody, { readonly _tag: "State" }>
		>,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly submit: (
		namespace: string,
		commandKey: Execution.CommandKey,
		input: Submission,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly locate: (
		id: Execution.Id,
		organizationId: string,
	) => Effect.Effect<
		{ namespace: string; id: Execution.Id },
		Execution.NotFound | Execution.StorageError
	>
	readonly get: (
		key: Key,
	) => Effect.Effect<
		Execution.Record,
		Execution.NotFound | Execution.StorageError
	>
	readonly load: (
		key: Key,
	) => Effect.Effect<Loaded, Execution.NotFound | Execution.StorageError>
	readonly loadMember: (
		key: Key,
	) => Effect.Effect<
		MemberExecution,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly loadService: (
		key: Key,
		serviceId: ServiceId,
	) => Effect.Effect<
		ServiceExecution,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly ownership: (
		key: Key,
	) => Effect.Effect<
		Pick<Submission, "ownerExecutionId">,
		Execution.NotFound | Execution.StorageError
	>
	readonly wake: (
		key: Key,
		signal: string,
	) => Effect.Effect<void, Execution.NotFound | Execution.StorageError>
	readonly notify: (
		key: Key,
		commandKey: Execution.CommandKey,
		actor: Caller | CommandActor,
		signalId: string,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly owned: (
		key: Key,
		activeOnly?: boolean | undefined,
	) => Effect.Effect<
		{
			key: { namespace: string; id: Execution.Id }
			record: Execution.Record
		}[],
		Execution.NotFound | Execution.StorageError
	>
	readonly hold: (
		key: Key,
	) => Effect.Effect<void, Execution.NotFound | Execution.StorageError>
	readonly guard: (
		key: Fence,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly lock: (
		key: Fence,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly takeOver: (
		key: Key,
	) => Effect.Effect<
		{ namespace: string; id: Execution.Id; generation: number },
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly failPhase: (
		key: Fence,
		failure: Execution.Failure,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly commit: <A, E, R>(
		key: Fence,
		change: {
			readonly status?: Execution.Status
			readonly failure?: Execution.Failure
			readonly events?:
				| ReadonlyArray<
						Exclude<Execution.EventBody, { readonly _tag: "State" }>
				  >
				| ((
						result: A,
				  ) => ReadonlyArray<
						Exclude<Execution.EventBody, { readonly _tag: "State" }>
				  >)
		},
		writes: Effect.Effect<A, E, R>,
	) => Effect.Effect<
		A,
		| Execution.Conflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
		| Exclude<E, EffectDrizzleQueryError | SqlError.SqlError>,
		R
	>
	readonly transition: (
		key: Fence,
		status: Execution.Status,
		failure?: Execution.Failure | undefined,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly events: (
		key: Key,
		afterSequence: number,
	) => Effect.Effect<
		{
			executionId: Execution.Id
			sequence: number
			createdAt: number
			body: Execution.EventBody
		}[],
		Execution.StorageError
	>
	readonly cancel: <E = never, R = never>(
		key: Key,
		commandKey: Execution.CommandKey,
		actor: Caller | CommandActor,
		beforeLock?: Effect.Effect<void, E, R> | undefined,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
		| Extract<E, typeof known.Type>,
		R
	>
	readonly finishCancellation: <E = never, R = never>(
		key: Fence,
		cancelEpoch: number,
		finish?:
			| ((
					status: "cancelled" | "interrupted" | "outcome_unknown",
			  ) => Effect.Effect<
					ReadonlyArray<
						Exclude<Execution.EventBody, { readonly _tag: "State" }>
					>,
					E,
					R
			  >)
			| undefined,
	) => Effect.Effect<
		"cancelled" | "interrupted" | "outcome_unknown",
		| Execution.Conflict
		| Execution.NotFound
		| Execution.StorageError
		| Extract<E, typeof known.Type>,
		R
	>
	readonly requestDecision: (
		key: Fence,
		id: string,
		choices: readonly [Execution.Answer, ...Execution.Answer[]],
	) => Effect.Effect<
		{
			id: string
			choices: readonly [Execution.Answer, ...Execution.Answer[]]
			answer: {
				readonly answer: Execution.Answer
				readonly actor: Caller
			} | null
		},
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly decision: (
		key: Key,
		id: string,
	) => Effect.Effect<
		| Option.None<{
				id: string
				choices: readonly [Execution.Answer, ...Execution.Answer[]]
				answer: {
					readonly answer: Execution.Answer
					readonly actor: Caller
				} | null
		  }>
		| Option.Some<{
				id: string
				choices: readonly [Execution.Answer, ...Execution.Answer[]]
				answer: {
					readonly answer: Execution.Answer
					readonly actor: Caller
				} | null
		  }>,
		Execution.StorageError
	>
	readonly decisionPending: (
		key: Key,
		id: string,
	) => Effect.Effect<boolean, Execution.NotFound | Execution.StorageError>
	readonly decide: <E = never, R = never>(
		key: Key,
		commandKey: Execution.CommandKey,
		id: string,
		answer: Execution.Answer,
		actor: Caller,
		change?: {
			readonly input: Schema.Json
			readonly apply: Effect.Effect<void, E, R>
		},
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
		| Exclude<E, EffectDrizzleQueryError | SqlError.SqlError>,
		R
	>
	readonly pending: (workflows: readonly string[]) => Effect.Effect<
		{
			namespace: string
			commandId: string
			executionId: string
			createdAt: number
			sentAt: number | null
		}[],
		Execution.StorageError
	>
	readonly acknowledge: (
		namespace: string,
		commandId: string,
	) => Effect.Effect<void, Execution.StorageError>
	readonly defer: (
		namespace: string,
		commandId: string,
	) => Effect.Effect<void, Execution.StorageError>
	readonly command: (
		namespace: string,
		commandId: string,
	) => Effect.Effect<
		Option.Option<{
			namespace: string
			id: string
			executionId: string
			organizationId: string | null
			userId: string | null
			principalKind: string
			serviceId: string | null
			key: string
			kind: string
			cancelEpoch: number | null
			sequence: number
			createdAt: number
			body: Schema.Json
		}>,
		Execution.StorageError
	>
	readonly intent: (
		key: Fence,
		input: {
			readonly step: string
			readonly attempt: number
			readonly retry: Execution.Retry
			readonly input: Schema.Json
		},
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly readAttempt: (
		key: Fence,
		step: string,
		input: Schema.Json,
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly writeAttempt: (
		key: Fence,
		step: string,
		input: Schema.Json,
		retry?: "idempotent" | "local" | "never" | undefined,
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly repeatCall: (
		key: Fence,
		id: Execution.CallId,
		result: Schema.Json,
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly retryCall: (
		key: Fence,
		id: Execution.CallId,
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly recoverCall: (
		key: Fence,
		id: Execution.CallId,
	) => Effect.Effect<
		| { _tag: "Retry"; decisionId?: never; afterSequence?: never }
		| { _tag: "Stop"; decisionId?: never; afterSequence?: never }
		| { _tag: "Recorded"; decisionId?: never; afterSequence?: never }
		| { _tag: "Pending"; decisionId: string; afterSequence: number },
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly sending: (
		key: Fence,
		id: Execution.CallId,
		admit?:
			| Effect.Effect<
					void,
					| Execution.Conflict
					| Execution.Forbidden
					| Execution.NotFound
					| Paused
					| Execution.StorageError
			  >
			| undefined,
	) => Effect.Effect<
		| Execution.Call
		| {
				id: Execution.CallId
				executionId: Execution.Id
				step: string
				attempt: number
				retry: Execution.Retry
				input: Schema.Json
				result: Schema.Json
				status: string
		  },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Paused
		| Execution.StorageError
	>
	readonly finishCall: <E = never, R = never>(
		key: Fence,
		id: Execution.CallId,
		result: Schema.Json,
		events?:
			| readonly (
					| {
							readonly _tag: "CallRecorded"
							readonly callId: Execution.CallId
							readonly step: string
							readonly attempt: number
					  }
					| {
							readonly _tag: "Checkpoint"
							readonly resource: Execution.Resource
							readonly revision: number
					  }
					| {
							readonly _tag: "ChildExecution"
							readonly executionId: Execution.Id
							readonly step: string
					  }
					| {
							readonly _tag: "DecisionMade"
							readonly decisionId: string
							readonly answer: Execution.Answer
					  }
					| {
							readonly _tag: "DecisionNeeded"
							readonly decisionId: string
							readonly choices: readonly [
								Execution.Answer,
								...Execution.Answer[],
							]
					  }
					| {
							readonly _tag: "InputMoved"
							readonly executionId: Execution.Id
							readonly items: readonly string[]
					  }
					| { readonly _tag: "Result"; readonly resource: Execution.Resource }
					| {
							readonly _tag: "StepCompleted"
							readonly step: string
							readonly attempt: number
					  }
					| {
							readonly _tag: "StepStarted"
							readonly step: string
							readonly attempt: number
					  }
					| {
							readonly _tag: "Text"
							readonly step: string
							readonly attempt: number
							readonly text: string
					  }
					| {
							readonly _tag: "ToolOutput"
							readonly step: string
							readonly attempt: number
							readonly output: Schema.Json
					  }
					| { readonly _tag: "Wake"; readonly key: string }
			  )[]
			| undefined,
		writes?: Effect.Effect<void, E, R> | undefined,
	) => Effect.Effect<
		boolean,
		| Execution.Conflict
		| Execution.NotFound
		| Execution.StorageError
		| Exclude<E, EffectDrizzleQueryError | SqlError.SqlError>,
		R
	>
	readonly uncertain: (
		key: Fence,
		id: Execution.CallId,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly incompleteRead: (
		key: Fence,
		id: Execution.CallId,
	) => Effect.Effect<
		void,
		Execution.Conflict | Execution.NotFound | Execution.StorageError
	>
	readonly call: (
		key: Key,
		id: Execution.CallId,
	) => Effect.Effect<Option.Option<Execution.Call>, Execution.StorageError>
	readonly firstCall: (
		key: Key,
		step: string,
	) => Effect.Effect<Option.Option<Execution.Call>, Execution.StorageError>
	readonly latestCall: (
		key: Key,
		step: string,
	) => Effect.Effect<Option.Option<Execution.Call>, Execution.StorageError>
	readonly latestCalls: (
		key: Key,
	) => Effect.Effect<Execution.Call[], Execution.StorageError>
	readonly calls: (
		key: Key,
	) => Effect.Effect<Execution.Call[], Execution.StorageError>
}

export class Store extends Context.Service<Store, Service>()(
	"@openbot-build/openbot/execution/Store",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const where = (key: Key) =>
		and(eq(executions.namespace, key.namespace), eq(executions.id, key.id))
	const binding = (key: Key, field: string) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
			"execution",
			key.namespace,
			key.id,
			field,
		])
	const seal = Effect.fn("ExecutionStore.seal")(function* (
		key: Key,
		field: string,
		value: string,
	) {
		return yield* secrets.seal(value, yield* binding(key, field))
	})
	const open = Effect.fn("ExecutionStore.open")(function* (
		key: Key,
		field: string,
		value: string,
	) {
		return yield* secrets.open(value, yield* binding(key, field))
	})
	const row = Effect.fn("ExecutionStore.row")(function* (
		key: Key,
		lock: boolean | "share" = false,
	) {
		const query = db.select().from(executions).where(where(key))
		const rows = yield* lock === "share"
			? query.for("share")
			: lock
				? query.for("update")
				: query
		const value = Arr.head(rows)
		if (Option.isNone(value))
			return yield* Execution.NotFound.make({ id: key.id })
		return value.value
	})
	const view = Effect.fn("ExecutionStore.view")(function* (
		value: typeof executions.$inferSelect,
	) {
		return yield* Schema.decodeUnknownEffect(Execution.Record)({
			id: value.id,
			resource: { kind: value.resourceKind, id: value.resourceId },
			status: value.status,
			sequence: value.sequence,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			failure:
				value.failure === null
					? null
					: yield* Schema.decodeEffect(failureCodec)(value.failure),
		})
	})
	const checkFence = Effect.fn("ExecutionStore.checkFence")(function* (
		key: Fence,
		shared: boolean = false,
	) {
		const value = yield* row(key, shared ? "share" : true)
		const state = yield* view(value)
		if (
			value.generation !== key.generation ||
			Execution.isTerminal(state.status)
		) {
			return yield* Execution.Conflict.make({ id: key.id })
		}
		return value
	})
	/** The caller holds the row lock. PostgreSQL sends the wake-up after commit. */
	const append = Effect.fn("ExecutionStore.append")(function* (
		key: Key,
		sequence: number,
		body: Execution.EventBody,
		now: number,
		eventKey?: string,
	) {
		const encoded = yield* Schema.encodeEffect(eventCodec)(body)
		yield* db.insert(executionEvents).values({
			namespace: key.namespace,
			executionId: key.id,
			sequence,
			key: eventKey ?? null,
			body: yield* seal(key, `event:${sequence}`, encoded),
			createdAt: now,
		})
		yield* db
			.update(executions)
			.set({ sequence, updatedAt: now })
			.where(where(key))
		yield* sql`select pg_notify('openbot_execution_events', '')`
	})
	const commandLock = (
		namespace: string,
		actor: CommandActor,
		key: Execution.CommandKey,
	) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
			namespace,
			...principal(actor),
			key,
		}).pipe(
			Effect.flatMap(
				(name) =>
					sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`,
			),
		)
	const findCommand = Effect.fn("ExecutionStore.findCommand")(function* (
		namespace: string,
		actor: CommandActor,
		key: Execution.CommandKey,
		body: Schema.Json,
	) {
		const scope = principal(actor)
		const rows = yield* db
			.select()
			.from(executionCommands)
			.where(
				and(
					eq(executionCommands.namespace, namespace),
					eq(executionCommands.principalKind, scope.principalKind),
					scope.organizationId === null
						? isNull(executionCommands.organizationId)
						: eq(executionCommands.organizationId, scope.organizationId),
					scope.userId === null
						? isNull(executionCommands.userId)
						: eq(executionCommands.userId, scope.userId),
					scope.serviceId === null
						? isNull(executionCommands.serviceId)
						: eq(executionCommands.serviceId, scope.serviceId),
					eq(executionCommands.key, key),
				),
			)
		const found = Arr.head(rows)
		if (Option.isNone(found)) return Option.none<Execution.Receipt>()
		const value = found.value
		const executionId = yield* Schema.decodeEffect(Execution.Id)(
			value.executionId,
		)
		const prior = yield* open(
			{ namespace, id: executionId },
			`command:${value.id}`,
			value.body,
		).pipe(Effect.flatMap(Schema.decodeEffect(json)))
		if (!sameJson(prior, body)) return yield* Execution.KeyConflict.make({})
		return Option.some({
			executionId,
			commandKey: key,
			sequence: value.sequence,
		})
	})
	const saveCommand = Effect.fn("ExecutionStore.saveCommand")(function* (
		key: Key,
		actor: CommandActor,
		commandKey: Execution.CommandKey,
		kind: string,
		body: Schema.Json,
		sequence: number,
		now: number,
		notify: boolean = true,
		cancelEpoch: number | null = null,
	) {
		const id = yield* crypto.randomUUIDv7()
		const encoded = yield* Schema.encodeEffect(json)(body)
		yield* db.insert(executionCommands).values({
			namespace: key.namespace,
			id,
			executionId: key.id,
			...principal(actor),
			key: commandKey,
			kind,
			cancelEpoch,
			body: yield* seal(key, `command:${id}`, encoded),
			sequence,
			createdAt: now,
		})
		if (notify)
			yield* db.insert(executionOutbox).values({
				namespace: key.namespace,
				commandId: id,
				executionId: key.id,
				createdAt: now,
			})
		return { executionId: key.id, commandKey, sequence }
	})

	/** Make an execution inside a command transaction. No engine message is sent yet. */
	const create = Effect.fn("ExecutionStore.create")(function* (
		namespace: string,
		input: Submission,
	) {
		const scope = principal(commandOwner(input.identity))
		if (input.ownerExecutionId !== undefined) {
			const owner = Arr.head(
				yield* db
					.select()
					.from(executions)
					.where(eq(executions.id, input.ownerExecutionId))
					.for("share"),
			)
			if (
				Option.isNone(owner) ||
				owner.value.organizationId !== scope.organizationId ||
				owner.value.principalKind !== scope.principalKind ||
				owner.value.serviceId !== scope.serviceId
			)
				return yield* Execution.Forbidden.make({})
			if (Execution.isTerminal((yield* view(owner.value)).status))
				return yield* Execution.Conflict.make({ id: input.ownerExecutionId })
		}
		const id = yield* Schema.decodeEffect(Execution.Id)(
			yield* crypto.randomUUIDv7(),
		)
		const key = { namespace, id }
		const now = yield* Clock.currentTimeMillis
		const identity = yield* Schema.encodeEffect(identityCodec)(input.identity)
		const payload = yield* Schema.encodeEffect(json)(input.input)
		yield* db.insert(executions).values({
			namespace,
			id,
			workflow: input.workflow,
			ownerExecutionId: input.ownerExecutionId ?? null,
			resourceKind: input.resource.kind,
			resourceId: input.resource.id,
			contextKind: input.context?.kind ?? null,
			contextId: input.context?.id ?? null,
			...scope,
			identity: yield* seal(key, "identity", identity),
			input: yield* seal(key, "input", payload),
			status: "queued",
			createdAt: now,
			updatedAt: now,
		})
		yield* append(
			key,
			1,
			{ _tag: "State", status: "queued", failure: null },
			now,
		)
		return key
	}, storage)

	/** Check one command key before its application writes. Only database work belongs in apply. */
	const accept = <E, R>(
		namespace: string,
		commandKey: Execution.CommandKey,
		input: {
			readonly actor: CommandActor
			readonly body: Schema.Json
		},
		apply: (
			allocate: (input: Submission) => ReturnType<typeof create>,
		) => Effect.Effect<
			{
				readonly executionId: Execution.Id
				readonly start: boolean
				readonly dispatch?: boolean
				readonly events?: ReadonlyArray<
					Exclude<Execution.EventBody, { readonly _tag: "State" }>
				>
			},
			E,
			R
		>,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const actor = input.actor
					yield* commandLock(namespace, actor, commandKey).pipe(storage)
					const prior = yield* findCommand(
						namespace,
						actor,
						commandKey,
						input.body,
					).pipe(storage)
					if (Option.isSome(prior)) return prior.value
					const result = yield* apply((input) => create(namespace, input))
					const key = { namespace, id: result.executionId }
					const execution = yield* row(key, true).pipe(storage)
					const now = yield* Clock.currentTimeMillis
					const events = result.events ?? []
					if (
						Arr.some(
							events,
							(event: Execution.EventBody) => event._tag === "State",
						)
					)
						return yield* Execution.Conflict.make({ id: key.id })
					for (const [index, event] of Arr.map(
						events,
						(event, index) => [index, event] as const,
					)) {
						yield* append(key, execution.sequence + index + 1, event, now).pipe(
							storage,
						)
					}
					return yield* saveCommand(
						key,
						actor,
						commandKey,
						result.start ? "start" : "input",
						input.body,
						execution.sequence + events.length,
						now,
						result.start && result.dispatch !== false,
					).pipe(storage)
				}),
			)
			.pipe(transactionFailures)

	const submit = Effect.fn("ExecutionStore.submit")(function* (
		namespace: string,
		commandKey: Execution.CommandKey,
		input: Submission,
	) {
		return yield* accept(
			namespace,
			commandKey,
			{
				actor: commandOwner(input.identity),
				body: yield* Schema.encodeEffect(Submission)(input),
			},
			(create) =>
				create(input).pipe(
					Effect.map((key) => ({ executionId: key.id, start: true })),
				),
		)
	}, storage)

	/** Admit queued work by making its saved start command ready for the engine. */
	const activate = Effect.fn("ExecutionStore.activate")(function* (
		key: Key,
		events: ReadonlyArray<
			Exclude<Execution.EventBody, { readonly _tag: "State" }>
		> = [],
	) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				if (
					Arr.some(
						events,
						(event: Execution.EventBody) => event._tag === "State",
					)
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const execution = yield* row(key, true)
				if (execution.status !== "queued")
					return yield* Execution.Conflict.make({ id: key.id })
				const [command] = yield* db
					.select({ id: executionCommands.id })
					.from(executionCommands)
					.where(
						and(
							eq(executionCommands.namespace, key.namespace),
							eq(executionCommands.executionId, key.id),
							eq(executionCommands.kind, "start"),
						),
					)
					.orderBy(asc(executionCommands.createdAt), asc(executionCommands.id))
					.limit(1)
				if (command === undefined)
					return yield* Execution.Conflict.make({ id: key.id })
				const inserted = yield* db
					.insert(executionOutbox)
					.values({
						namespace: key.namespace,
						commandId: command.id,
						executionId: key.id,
						createdAt: yield* Clock.currentTimeMillis,
					})
					.onConflictDoNothing()
					.returning({ id: executionOutbox.commandId })
				if (inserted.length > 0) {
					const now = yield* Clock.currentTimeMillis
					yield* Effect.forEach(events, (event, index) =>
						append(key, execution.sequence + index + 1, event, now),
					)
				}
			}),
		)
	}, storage)

	const locate = Effect.fn("ExecutionStore.locate")(function* (
		id: Execution.Id,
		organizationId: string,
	) {
		const values = yield* db
			.select({ namespace: executions.namespace })
			.from(executions)
			.where(
				and(
					eq(executions.id, id),
					eq(executions.organizationId, organizationId),
				),
			)
		const found = Arr.head(values)
		if (Option.isNone(found)) return yield* Execution.NotFound.make({ id })
		return { namespace: found.value.namespace, id }
	}, storage)
	const get = Effect.fn("ExecutionStore.get")(function* (key: Key) {
		return yield* view(yield* row(key))
	}, storage)
	const load = Effect.fn("ExecutionStore.load")(function* (key: Key) {
		const value = yield* row(key)
		return {
			record: yield* view(value),
			workflow: value.workflow,
			context:
				value.contextKind === null || value.contextId === null
					? null
					: { kind: value.contextKind, id: value.contextId },
			generation: value.generation,
			cancelEpoch: value.cancelEpoch,
			cancelPending: value.cancelPending,
			phaseFailed: value.phaseFailed,
			identity: yield* open(key, "identity", value.identity).pipe(
				Effect.flatMap(Schema.decodeEffect(identityCodec)),
			),
			input: yield* open(key, "input", value.input).pipe(
				Effect.flatMap(Schema.decodeEffect(json)),
			),
		}
	}, storage)
	/** Member workflows must not read service work as a member identity. */
	const loadMember = Effect.fn("ExecutionStore.loadMember")(function* (
		key: Key,
	) {
		const saved = yield* load(key)
		if (!Schema.is(ExecutionIdentity)(saved.identity))
			return yield* Execution.Forbidden.make({})
		const identity: ExecutionIdentity = saved.identity
		return { ...saved, identity }
	})
	/** A service workflow can only open work for its own declared service. */
	const loadService = Effect.fn("ExecutionStore.loadService")(function* (
		key: Key,
		serviceId: ServiceId,
	) {
		const saved = yield* load(key)
		if (
			!Schema.is(ServiceIdentity)(saved.identity) ||
			saved.identity.actor.serviceId !== serviceId
		)
			return yield* Execution.Forbidden.make({})
		const identity: ServiceIdentity = saved.identity
		return { ...saved, identity }
	})
	/** Wake an owner once for a saved condition. This never adds events after its end. */
	const wake = Effect.fn("ExecutionStore.wake")(function* (
		key: Key,
		signal: string,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* row(key, true)
				if (Execution.isTerminal((yield* view(execution)).status)) return
				const prior = yield* db
					.select({ sequence: executionEvents.sequence })
					.from(executionEvents)
					.where(
						and(
							eq(executionEvents.namespace, key.namespace),
							eq(executionEvents.executionId, key.id),
							eq(executionEvents.key, `wake:${signal}`),
						),
					)
					.limit(1)
				if (prior.length > 0) return
				yield* append(
					key,
					execution.sequence + 1,
					{ _tag: "Wake", key: signal },
					yield* Clock.currentTimeMillis,
					`wake:${signal}`,
				)
			}),
		)
	}, storage)
	/** Commit a named wake-up with feature changes in the caller's transaction. */
	const notify = Effect.fn("ExecutionStore.notify")(function* (
		key: Key,
		commandKey: Execution.CommandKey,
		actor: Caller | CommandActor,
		signalId: string,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const body = { kind: "notify", executionId: key.id, signalId, actor }
				yield* commandLock(key.namespace, actor, commandKey)
				const prior = yield* findCommand(key.namespace, actor, commandKey, body)
				if (Option.isSome(prior)) return prior.value
				const execution = yield* row(key, true)
				if (Execution.isTerminal((yield* view(execution)).status))
					return yield* Execution.Conflict.make({ id: key.id })
				const now = yield* Clock.currentTimeMillis
				const sequence = execution.sequence + 1
				yield* append(key, sequence, { _tag: "Wake", key: signalId }, now)
				return yield* saveCommand(
					key,
					actor,
					commandKey,
					"signal",
					body,
					sequence,
					now,
				)
			}),
		)
	}, storage)
	/** Execution ownership is separate from the caller and the source used for access checks. */
	const ownership = Effect.fn("ExecutionStore.ownership")(function* (
		key: Key,
	): Effect.fn.Return<
		Pick<Submission, "ownerExecutionId">,
		Execution.NotFound | Execution.StorageError
	> {
		const found = yield* row(key).pipe(storage)
		return found.ownerExecutionId === null
			? {}
			: { ownerExecutionId: Execution.Id.make(found.ownerExecutionId) }
	})
	/** A workflow observes the returned executions, then reads this index again before ending. */
	const owned = Effect.fn("ExecutionStore.owned")(function* (
		key: Key,
		activeOnly: boolean = false,
	) {
		const owner = yield* row(key)
		return yield* Effect.forEach(
			yield* db
				.select()
				.from(executions)
				.where(
					and(
						eq(executions.ownerExecutionId, key.id),
						owner.organizationId === null
							? isNull(executions.organizationId)
							: eq(executions.organizationId, owner.organizationId),
						activeOnly
							? notInArray(executions.status, [
									"completed",
									"failed",
									"cancelled",
									"interrupted",
								])
							: undefined,
					),
				)
				.orderBy(asc(executions.createdAt), asc(executions.id)),
			(entry) =>
				Effect.map(view(entry), (record) => ({
					key: { namespace: entry.namespace, id: record.id },
					record,
				})),
		)
	}, storage)
	const requireReleased = (key: Key) =>
		Effect.gen(function* () {
			const active = yield* db
				.select({ id: executions.id })
				.from(executions)
				.where(
					and(
						eq(executions.ownerExecutionId, key.id),
						notInArray(executions.status, [
							"completed",
							"failed",
							"cancelled",
							"interrupted",
						]),
					),
				)
				.limit(1)
			if (active.length > 0)
				return yield* Execution.Conflict.make({ id: key.id })
		})
	/** Only the engine's owner may call this when it starts or resumes work. */
	const takeOver = Effect.fn("ExecutionStore.takeOver")(function* (key: Key) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const value = yield* row(key, true)
				const current = yield* view(value)
				if (Execution.isTerminal(current.status))
					return yield* Execution.Conflict.make({ id: key.id })
				const generation = value.generation + 1
				const status = current.status === "queued" ? "running" : current.status
				const now = yield* Clock.currentTimeMillis
				yield* db
					.update(executions)
					.set({ generation, status, updatedAt: now })
					.where(where(key))
				if (status !== current.status)
					yield* append(
						key,
						value.sequence + 1,
						{ _tag: "State", status, failure: current.failure },
						now,
					)
				return { ...key, generation }
			}),
		)
	}, storage)
	/** Keep a phase failure across cancellation and owner loss. New work must not pass it. */
	const failPhase = Effect.fn("ExecutionStore.failPhase")(function* (
		key: Fence,
		failure: Execution.Failure,
	) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const value = yield* checkFence(key)
				if (value.phaseFailed) return
				yield* db
					.update(executions)
					.set({
						phaseFailed: true,
						failure: yield* Schema.encodeEffect(failureCodec)(failure),
					})
					.where(where(key))
				yield* append(
					key,
					value.sequence + 1,
					{ _tag: "State", status: (yield* view(value)).status, failure },
					yield* Clock.currentTimeMillis,
				)
				const pending = yield* db
					.select()
					.from(executionDecisions)
					.where(
						and(
							eq(executionDecisions.namespace, key.namespace),
							eq(executionDecisions.executionId, key.id),
							isNull(executionDecisions.answer),
						),
					)
				let sequence = value.sequence + 1
				for (const entry of pending) {
					const choices = yield* Schema.decodeEffect(choicesCodec)(
						entry.choices,
					)
					if (!Arr.contains(choices, "retry") || !Arr.contains(choices, "stop"))
						continue
					yield* db
						.update(executionDecisions)
						.set({
							choices: yield* Schema.encodeEffect(choicesCodec)(["stop"]),
						})
						.where(decisionWhere(key, entry.id))
					yield* append(
						key,
						++sequence,
						{ _tag: "DecisionNeeded", decisionId: entry.id, choices: ["stop"] },
						yield* Clock.currentTimeMillis,
					)
				}
			}),
		)
	}, storage)
	/** The supplied database writes, state, and events share one transaction. */
	const commit = <A, E, R>(
		key: Fence,
		change: {
			readonly status?: Execution.Status
			readonly failure?: Execution.Failure
			readonly events?:
				| ReadonlyArray<
						Exclude<Execution.EventBody, { readonly _tag: "State" }>
				  >
				| ((
						result: A,
				  ) => ReadonlyArray<
						Exclude<Execution.EventBody, { readonly _tag: "State" }>
				  >)
		},
		writes: Effect.Effect<A, E, R>,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const value = yield* checkFence(key)
					const current = yield* view(value)
					// Stopped work cannot keep writing while its cancellation is being released.
					// Waiting work needs an explicit state change before it can advance.
					if (
						current.status === "cancelling" ||
						(value.phaseFailed &&
							change.status !== "failed" &&
							change.status !== "interrupted" &&
							change.status !== "outcome_unknown") ||
						(current.status !== "running" && change.status === undefined)
					)
						return yield* Execution.Conflict.make({ id: key.id })

					if (
						change.status !== undefined &&
						!Execution.canTransition(current.status, change.status)
					) {
						return yield* Execution.Conflict.make({ id: key.id })
					}
					const result = yield* writes
					if (
						change.status !== undefined &&
						Execution.isTerminal(change.status)
					)
						yield* requireReleased(key)
					const supplied =
						typeof change.events === "function"
							? change.events(result)
							: (change.events ?? [])
					if (
						Arr.some(
							supplied,
							(event: Execution.EventBody) => event._tag === "State",
						)
					) {
						return yield* Execution.Conflict.make({ id: key.id })
					}
					const now = yield* Clock.currentTimeMillis
					const events: ReadonlyArray<Execution.EventBody> =
						change.status === undefined
							? supplied
							: Arr.append(supplied, {
									_tag: "State",
									status: change.status,
									failure: value.phaseFailed
										? current.failure
										: (change.failure ?? null),
								})
					if (change.status !== undefined) {
						yield* db
							.update(executions)
							.set({
								status: change.status,
								failure: value.phaseFailed
									? value.failure
									: change.failure === undefined
										? null
										: yield* Schema.encodeEffect(failureCodec)(change.failure),
								updatedAt: now,
							})
							.where(where(key))
					}
					yield* Effect.forEach(events, (body, index) =>
						append(key, value.sequence + index + 1, body, now),
					)
					return result
				}),
			)
			.pipe(transactionFailures)
	const transition = Effect.fn("ExecutionStore.transition")(function* (
		key: Fence,
		status: Execution.Status,
		failure?: Execution.Failure,
	) {
		yield* commit(
			key,
			{ status, ...(failure === undefined ? {} : { failure }) },
			Effect.void,
		)
	}, storage)
	const events = Effect.fn("ExecutionStore.events")(function* (
		key: Key,
		afterSequence: number,
	) {
		const values = yield* db
			.select()
			.from(executionEvents)
			.where(
				and(
					eq(executionEvents.namespace, key.namespace),
					eq(executionEvents.executionId, key.id),
					gt(executionEvents.sequence, afterSequence),
				),
			)
			.orderBy(asc(executionEvents.sequence))
			.limit(128)
		return yield* Effect.forEach(
			values,
			Effect.fn(function* (value) {
				const body = yield* open(
					key,
					`event:${value.sequence}`,
					value.body,
				).pipe(Effect.flatMap(Schema.decodeEffect(eventCodec)))
				return {
					executionId: key.id,
					sequence: value.sequence,
					createdAt: value.createdAt,
					body,
				}
			}),
		)
	}, storage)
	const cancel = Effect.fn("ExecutionStore.cancel")(function* <
		E = never,
		R = never,
	>(
		key: Key,
		commandKey: Execution.CommandKey,
		actor: Caller | CommandActor,
		beforeLock?: Effect.Effect<void, E, R>,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const body = { kind: "cancel", executionId: key.id, actor }
				yield* commandLock(key.namespace, actor, commandKey)
				const prior = yield* findCommand(key.namespace, actor, commandKey, body)
				if (Option.isSome(prior)) return prior.value
				if (beforeLock !== undefined) yield* beforeLock
				const value = yield* row(key, true)
				const state = yield* view(value)
				if (Execution.isTerminal(state.status))
					return yield* Execution.Conflict.make({ id: key.id })
				const now = yield* Clock.currentTimeMillis
				const cancelEpoch =
					state.status === "cancelling"
						? value.cancelEpoch
						: value.cancelEpoch + 1
				const sequence =
					state.status === "cancelling" ? value.sequence : value.sequence + 1
				if (state.status !== "cancelling") {
					yield* db
						.update(executions)
						.set({ status: "cancelling", cancelEpoch, cancelPending: true })
						.where(where(key))
					yield* append(
						key,
						sequence,
						{ _tag: "State", status: "cancelling", failure: state.failure },
						now,
					)
				}
				return yield* saveCommand(
					key,
					actor,
					commandKey,
					"cancel",
					body,
					sequence,
					now,
					true,
					cancelEpoch,
				)
			}),
		)
	}, storage)
	/** The current owner calls this after the work scope and feature resources close. */
	const finishCancellation = Effect.fn("ExecutionStore.finishCancellation")(
		function* <E = never, R = never>(
			key: Fence,
			cancelEpoch: number,
			finish?: (
				status: "cancelled" | "interrupted" | "outcome_unknown",
			) => Effect.Effect<
				ReadonlyArray<Exclude<Execution.EventBody, { readonly _tag: "State" }>>,
				E,
				R
			>,
		) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const execution = yield* row(key, true)
					if (
						execution.generation !== key.generation ||
						execution.cancelEpoch !== cancelEpoch
					)
						return yield* Execution.Conflict.make({ id: key.id })
					if (
						execution.status === "cancelled" ||
						execution.status === "interrupted" ||
						execution.status === "outcome_unknown"
					)
						return execution.status
					if (execution.status !== "cancelling")
						return yield* Execution.Conflict.make({ id: key.id })
					const calls = yield* db
						.select()
						.from(executionCalls)
						.where(
							and(
								eq(executionCalls.namespace, key.namespace),
								eq(executionCalls.executionId, key.id),
							),
						)
						.for("update")
					// A saved retry decision supersedes the old attempt. Keep its unknown
					// result for audit, but only the last attempt can block this phase.
					const latest = Arr.filter(
						calls,
						(call) =>
							!Arr.some(
								calls,
								(other) =>
									other.step === call.step && other.attempt > call.attempt,
							),
					)
					const status = Arr.some(
						latest,
						(call) =>
							call.retry !== "read_only" &&
							call.retry !== "local" &&
							(call.status === "sending" || call.status === "outcome_unknown"),
					)
						? "outcome_unknown"
						: execution.phaseFailed
							? "interrupted"
							: "cancelled"
					const events = finish === undefined ? [] : yield* finish(status)
					if (Execution.isTerminal(status)) yield* requireReleased(key)
					const now = yield* Clock.currentTimeMillis
					yield* db
						.update(executionCalls)
						.set({ status: "outcome_unknown", updatedAt: now })
						.where(
							and(
								eq(executionCalls.namespace, key.namespace),
								eq(executionCalls.executionId, key.id),
								eq(executionCalls.status, "sending"),
							),
						)
					yield* db
						.update(executions)
						.set({
							status,
						})
						.where(where(key))
					for (const [index, event] of Arr.map(
						[
							...events,
							{
								_tag: "State",
								status,
								failure: (yield* view(execution)).failure,
							} as const,
						],
						(event, index) => [index, event] as const,
					))
						yield* append(key, execution.sequence + index + 1, event, now)
					if (status === "outcome_unknown")
						for (const call of latest)
							if (
								(call.retry === "never" || call.retry === "idempotent") &&
								(call.status === "sending" || call.status === "outcome_unknown")
							)
								yield* requestDecision(
									key,
									Execution.callDecisionId(
										Execution.CallId.make(call.id),
										execution.cancelEpoch,
									),
									call.retry === "idempotent" ? ["stop"] : ["retry", "stop"],
								)
					return status
				}),
			)
		},
		storage,
	)
	const decisionWhere = (key: Key, id: string) =>
		and(
			eq(executionDecisions.namespace, key.namespace),
			eq(executionDecisions.executionId, key.id),
			eq(executionDecisions.id, id),
		)
	const answerCodec = Schema.fromJsonString(
		Schema.Struct({ answer: Execution.Answer, actor: Caller }),
	)
	const choicesCodec = Schema.fromJsonString(
		Schema.NonEmptyArray(Execution.Answer),
	)
	const decision = Effect.fn("ExecutionStore.decision")(function* (
		key: Key,
		id: string,
	) {
		const found = Arr.head(
			yield* db.select().from(executionDecisions).where(decisionWhere(key, id)),
		)
		if (Option.isNone(found)) return Option.none()
		const row = found.value
		const choices = yield* Schema.decodeEffect(choicesCodec)(row.choices)
		const answer =
			row.answer === null
				? null
				: yield* open(key, `decision:${id}`, row.answer).pipe(
						Effect.flatMap(Schema.decodeEffect(answerCodec)),
					)
		return Option.some({ id, choices, answer })
	}, storage)
	/** A feature can ask for a decision without stopping its other work. */
	const requestDecision = Effect.fn("ExecutionStore.requestDecision")(
		function* (
			key: Fence,
			id: string,
			choices: readonly [Execution.Answer, ...Execution.Answer[]],
		) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const execution = yield* checkFence(key)
					if (execution.status === "cancelling")
						return yield* Execution.Conflict.make({ id: key.id })
					const allowed =
						execution.phaseFailed &&
						Arr.contains(choices, "retry") &&
						Arr.contains(choices, "stop")
							? (["stop"] as const)
							: choices
					const found = yield* decision(key, id)
					if (Option.isSome(found)) {
						if (
							found.value.answer === null &&
							!sameJson(found.value.choices, allowed)
						)
							return yield* Execution.Conflict.make({ id: key.id })
						return found.value
					}
					const now = yield* Clock.currentTimeMillis
					yield* db.insert(executionDecisions).values({
						namespace: key.namespace,
						executionId: key.id,
						id,
						choices: yield* Schema.encodeEffect(choicesCodec)(allowed),
						createdAt: now,
					})
					yield* append(
						key,
						execution.sequence + 1,
						{ _tag: "DecisionNeeded", decisionId: id, choices: allowed },
						now,
					)
					return { id, choices: allowed, answer: null }
				}),
			)
		},
		storage,
	)
	/**
	 * The use case checks permission first. Feature writes, the answer, its event,
	 * and its signal share one transaction. Only database work belongs in apply.
	 */
	const callDecisionIsCurrent = Effect.fn(
		"ExecutionStore.callDecisionIsCurrent",
	)(function* (key: Key, id: string, cancelEpoch: number) {
		const history = yield* db
			.select({
				id: executionCalls.id,
				step: executionCalls.step,
				attempt: executionCalls.attempt,
				status: executionCalls.status,
			})
			.from(executionCalls)
			.where(
				and(
					eq(executionCalls.namespace, key.namespace),
					eq(executionCalls.executionId, key.id),
				),
			)
		const call = Arr.findFirst(history, (call) =>
			Execution.isCallDecision(id, Execution.CallId.make(call.id)),
		)
		return (
			Option.isNone(call) ||
			(id ===
				Execution.callDecisionId(
					Execution.CallId.make(call.value.id),
					cancelEpoch,
				) &&
				call.value.status === "outcome_unknown" &&
				!Arr.some(
					history,
					(other) =>
						other.step === call.value.step &&
						other.attempt > call.value.attempt,
				))
		)
	})

	/** Hold the execution lock until the caller commits its response to this decision. */
	const decisionPending = Effect.fn("ExecutionStore.decisionPending")(
		function* (key: Key, id: string) {
			const execution = yield* row(key, true)
			if (
				Execution.isTerminal((yield* view(execution)).status) ||
				execution.status === "cancelling"
			)
				return false
			if (!(yield* callDecisionIsCurrent(key, id, execution.cancelEpoch)))
				return false
			const found = yield* decision(key, id)
			return Option.isSome(found) && found.value.answer === null
		},
		storage,
	)

	const decide = <E = never, R = never>(
		key: Key,
		commandKey: Execution.CommandKey,
		id: string,
		answer: Execution.Answer,
		actor: Caller,
		change?: {
			/** Include all feature input so a changed retry cannot reuse the receipt. */
			readonly input: Schema.Json
			/** Update feature records only. The decision owns its execution event sequence. */
			readonly apply: Effect.Effect<void, E, R>
		},
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const body = {
						kind: "decision",
						executionId: key.id,
						decisionId: id,
						answer,
						actor,
						...(change === undefined ? {} : { change: change.input }),
					}
					const prepared = yield* Effect.gen(function* () {
						yield* commandLock(key.namespace, actor, commandKey)
						const prior = yield* findCommand(
							key.namespace,
							actor,
							commandKey,
							body,
						)
						if (Option.isSome(prior))
							return { _tag: "Saved" as const, receipt: prior.value }
						const execution = yield* row(key, true)
						const current = yield* view(execution)
						if (
							Execution.isTerminal(current.status) ||
							current.status === "cancelling" ||
							(execution.phaseFailed && answer === "retry")
						)
							return yield* Execution.Conflict.make({ id: key.id })
						if (!(yield* callDecisionIsCurrent(key, id, execution.cancelEpoch)))
							return yield* Execution.Conflict.make({ id: key.id })
						const found = yield* decision(key, id)
						if (
							Option.isNone(found) ||
							found.value.answer !== null ||
							!Arr.contains(found.value.choices, answer)
						)
							return yield* Execution.Conflict.make({ id: key.id })
						return { _tag: "New" as const, sequence: execution.sequence + 1 }
					}).pipe(storage)
					if (prepared._tag === "Saved") return prepared.receipt
					if (change !== undefined) yield* change.apply
					return yield* Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						yield* db
							.update(executionDecisions)
							.set({
								answer: yield* seal(
									key,
									`decision:${id}`,
									yield* Schema.encodeEffect(answerCodec)({ answer, actor }),
								),
								answeredAt: now,
							})
							.where(decisionWhere(key, id))
						yield* append(
							key,
							prepared.sequence,
							{ _tag: "DecisionMade", decisionId: id, answer },
							now,
						)
						return yield* saveCommand(
							key,
							actor,
							commandKey,
							"signal",
							body,
							prepared.sequence,
							now,
						)
					}).pipe(storage)
				}),
			)
			.pipe(transactionFailures)
	const pending = Effect.fn("ExecutionStore.pending")(function* (
		workflows: ReadonlyArray<string>,
	) {
		const now = yield* Clock.currentTimeMillis
		return yield* db
			.select({
				namespace: executionOutbox.namespace,
				commandId: executionOutbox.commandId,
				executionId: executionOutbox.executionId,
				createdAt: executionOutbox.createdAt,
				sentAt: executionOutbox.sentAt,
			})
			.from(executionOutbox)
			.innerJoin(
				executions,
				and(
					eq(executions.namespace, executionOutbox.namespace),
					eq(executions.id, executionOutbox.executionId),
				),
			)
			.where(
				and(
					isNull(executionOutbox.sentAt),
					lte(executionOutbox.retryAt, now),
					inArray(executions.workflow, workflows),
				),
			)
			.orderBy(asc(executionOutbox.retryAt), asc(executionOutbox.createdAt))
			.limit(128)
	}, storage)
	const defer = Effect.fn("ExecutionStore.defer")(function* (
		namespace: string,
		commandId: string,
	) {
		yield* db
			.update(executionOutbox)
			.set({ retryAt: (yield* Clock.currentTimeMillis) + 500 })
			.where(
				and(
					eq(executionOutbox.namespace, namespace),
					eq(executionOutbox.commandId, commandId),
					isNull(executionOutbox.sentAt),
				),
			)
	}, storage)
	const acknowledge = Effect.fn("ExecutionStore.acknowledge")(function* (
		namespace: string,
		commandId: string,
	) {
		yield* db
			.update(executionOutbox)
			.set({ sentAt: yield* Clock.currentTimeMillis })
			.where(
				and(
					eq(executionOutbox.namespace, namespace),
					eq(executionOutbox.commandId, commandId),
				),
			)
	}, storage)
	const command = Effect.fn("ExecutionStore.command")(function* (
		namespace: string,
		commandId: string,
	) {
		const found = yield* db
			.select()
			.from(executionCommands)
			.where(
				and(
					eq(executionCommands.namespace, namespace),
					eq(executionCommands.id, commandId),
				),
			)
		const value = Arr.head(found)
		if (Option.isNone(value)) return value
		return Option.some({
			...value.value,
			body: yield* open(
				{
					namespace,
					id: yield* Schema.decodeEffect(Execution.Id)(value.value.executionId),
				},
				`command:${commandId}`,
				value.value.body,
			).pipe(Effect.flatMap(Schema.decodeEffect(json))),
		})
	}, storage)
	const callView = Effect.fn("ExecutionStore.callView")(function* (
		value: typeof executionCalls.$inferSelect,
	) {
		const key = {
			namespace: value.namespace,
			id: yield* Schema.decodeEffect(Execution.Id)(value.executionId),
		}
		return yield* Schema.decodeUnknownEffect(Execution.Call)({
			id: value.id,
			executionId: value.executionId,
			step: value.step,
			attempt: value.attempt,
			status: value.status,
			retry: value.retry,
			input: yield* open(key, `call:${value.id}:input`, value.input).pipe(
				Effect.flatMap(Schema.decodeEffect(json)),
			),
			result:
				value.result === null
					? null
					: yield* open(key, `call:${value.id}:result`, value.result).pipe(
							Effect.flatMap(Schema.decodeEffect(json)),
						),
		})
	})
	const intent = Effect.fn("ExecutionStore.intent")(function* (
		key: Fence,
		input: {
			readonly step: string
			readonly attempt: number
			readonly retry: Execution.Retry
			readonly input: Schema.Json
		},
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* checkFence(key)
				const rows = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.step, input.step),
							eq(executionCalls.attempt, input.attempt),
						),
					)
				const prior = Arr.head(rows)
				if (Option.isSome(prior)) {
					const call = yield* callView(prior.value)
					if (call.retry !== input.retry || !sameJson(call.input, input.input))
						return yield* Execution.Conflict.make({ id: key.id })
					return call
				}
				const id = yield* Schema.decodeEffect(Execution.CallId)(
					yield* crypto.randomUUIDv7(),
				)
				const now = yield* Clock.currentTimeMillis
				yield* db.insert(executionCalls).values({
					namespace: key.namespace,
					id,
					executionId: key.id,
					step: input.step,
					attempt: input.attempt,
					generation: key.generation,
					status: "intended",
					retry: input.retry,
					input: yield* seal(
						key,
						`call:${id}:input`,
						yield* Schema.encodeEffect(json)(input.input),
					),
					createdAt: now,
					updatedAt: now,
				})
				return {
					id,
					executionId: key.id,
					...input,
					status: "intended" as const,
					result: null,
				}
			}),
		)
	}, storage)
	/** A read with no saved result gets a new attempt. Text from two attempts stays separate. */
	const readAttempt = Effect.fn("ExecutionStore.readAttempt")(function* (
		key: Fence,
		step: string,
		input: Schema.Json,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				if (execution.status !== "running")
					return yield* Execution.Conflict.make({ id: key.id })
				const [prior] = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.step, step),
						),
					)
					.orderBy(desc(executionCalls.attempt))
					.limit(1)
					.for("update")
				if (prior !== undefined) {
					const call = yield* callView(prior)
					if (call.retry !== "read_only" || !sameJson(call.input, input))
						return yield* Execution.Conflict.make({ id: key.id })
					if (call.status === "completed" || call.status === "intended")
						return call
					if (call.status === "sending" && prior.generation === key.generation)
						return yield* Execution.Conflict.make({ id: key.id })
					// The old provider may have billed the request. This does not claim zero usage.
					yield* db
						.update(executionCalls)
						.set({
							status: "outcome_unknown",
							updatedAt: yield* Clock.currentTimeMillis,
						})
						.where(
							and(
								eq(executionCalls.namespace, key.namespace),
								eq(executionCalls.id, call.id),
							),
						)
				}
				const call = yield* intent(key, {
					step,
					attempt: prior === undefined ? 0 : prior.attempt + 1,
					retry: "read_only",
					input,
				})
				yield* append(
					key,
					execution.sequence + 1,
					{ _tag: "StepStarted", step, attempt: call.attempt },
					yield* Clock.currentTimeMillis,
				)
				return call
			}),
		)
	}, storage)

	/** A write keeps its call ID. Only a durable receipt permits an automatic retry. */
	const writeAttempt = Effect.fn("ExecutionStore.writeAttempt")(function* (
		key: Fence,
		step: string,
		input: Schema.Json,
		retry: "never" | "idempotent" | "local" = "never",
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				if (
					execution.status !== "running" &&
					execution.status !== "outcome_unknown"
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const [prior] = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.step, step),
						),
					)
					.orderBy(desc(executionCalls.attempt))
					.limit(1)
				if (prior !== undefined) {
					const call = yield* callView(prior)
					if (call.retry !== retry || !sameJson(call.input, input))
						return yield* Execution.Conflict.make({ id: key.id })
					return call
				}
				if (execution.status !== "running")
					return yield* Execution.Conflict.make({ id: key.id })
				const call = yield* intent(key, {
					step,
					attempt: 0,
					retry,
					input,
				})
				yield* append(
					key,
					execution.sequence + 1,
					{ _tag: "StepStarted", step, attempt: 0 },
					yield* Clock.currentTimeMillis,
				)
				return call
			}),
		)
	}, storage)
	/** A feature may retry a confirmed refusal. It must name the exact saved result. */
	const repeatCall = Effect.fn("ExecutionStore.repeatCall")(function* (
		key: Fence,
		id: Execution.CallId,
		result: Schema.Json,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				if (execution.status !== "running" || execution.phaseFailed)
					return yield* Execution.Conflict.make({ id: key.id })
				const history = yield* calls(key)
				const found = Arr.findFirst(history, (call) => call.id === id)
				if (Option.isNone(found))
					return yield* Execution.NotFound.make({ id: key.id })
				const call = found.value
				if (call.status !== "completed" || !sameJson(call.result, result))
					return yield* Execution.Conflict.make({ id: key.id })
				const next = Arr.findFirst(
					history,
					(entry) =>
						entry.step === call.step && entry.attempt === call.attempt + 1,
				)
				if (Option.isSome(next)) return next.value
				const created = yield* intent(key, {
					step: call.step,
					attempt: call.attempt + 1,
					retry: call.retry,
					input: call.input,
				})
				yield* append(
					key,
					execution.sequence + 1,
					{ _tag: "StepStarted", step: created.step, attempt: created.attempt },
					yield* Clock.currentTimeMillis,
				)
				return created
			}),
		)
	}, storage)
	/** Consume a saved retry. Calls checks both callers before sending the new attempt. */
	const retryCall = Effect.fn("ExecutionStore.retryCall")(function* (
		key: Fence,
		id: Execution.CallId,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				if (execution.phaseFailed)
					return yield* Execution.Conflict.make({ id: key.id })
				if (
					execution.status !== "running" &&
					execution.status !== "outcome_unknown"
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const [prior] = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.id, id),
						),
					)
				if (prior === undefined)
					return yield* Execution.NotFound.make({ id: key.id })
				const call = yield* callView(prior)
				const saved = yield* decision(
					key,
					Execution.callDecisionId(id, execution.cancelEpoch),
				)
				if (
					Option.isNone(saved) ||
					saved.value.answer?.answer !== "retry" ||
					call.retry !== "never"
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const [existing] = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.step, call.step),
							eq(executionCalls.attempt, call.attempt + 1),
						),
					)
				// A repeated decision must not change a newer attempt's state.
				if (existing !== undefined) return yield* callView(existing)
				// If a late result arrived before the retry, use it instead of sending again.
				const next =
					call.status === "completed"
						? call
						: call.status === "outcome_unknown"
							? yield* intent(key, {
									step: call.step,
									attempt: call.attempt + 1,
									retry: call.retry,
									input: call.input,
								})
							: undefined
				if (next === undefined)
					return yield* Execution.Conflict.make({ id: key.id })
				let sequence = execution.sequence
				if (execution.status === "outcome_unknown") {
					yield* db
						.update(executions)
						.set({ status: "running", failure: null, cancelPending: false })
						.where(where(key))
					yield* append(
						key,
						++sequence,
						{ _tag: "State", status: "running", failure: null },
						yield* Clock.currentTimeMillis,
					)
				}
				if (next.id !== call.id)
					yield* append(
						key,
						++sequence,
						{ _tag: "StepStarted", step: next.step, attempt: next.attempt },
						yield* Clock.currentTimeMillis,
					)
				return next
			}),
		)
	}, storage)

	/** Read a call, its choice, and its wake cursor under the same owner lock. */
	const recoverCall = Effect.fn("ExecutionStore.recoverCall")(function* (
		key: Fence,
		id: Execution.CallId,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				const history = yield* calls(key)
				const found = Arr.findFirst(history, (call) => call.id === id)
				if (Option.isNone(found))
					return yield* Execution.NotFound.make({ id: key.id })
				const call = found.value
				if (
					(call.retry !== "never" && call.retry !== "idempotent") ||
					(call.status !== "outcome_unknown" && call.status !== "completed")
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const decisionId = Execution.callDecisionId(id, execution.cancelEpoch)
				const saved = yield* decision(key, decisionId)
				const answer = Option.isSome(saved)
					? saved.value.answer?.answer
					: undefined
				// A repeated recovery cannot change a newer attempt or its state.
				if (
					Arr.some(
						history,
						(other) => other.step === call.step && other.attempt > call.attempt,
					)
				)
					return { _tag: "Retry" as const }
				if (answer === "stop") return { _tag: "Stop" as const }
				if (call.status === "completed") {
					const unresolved = Arr.some(
						history,
						(other) =>
							(other.retry === "never" || other.retry === "idempotent") &&
							(other.status === "outcome_unknown" ||
								(other.status === "sending" && other.retry === "never")) &&
							!Arr.some(
								history,
								(next) =>
									next.step === other.step && next.attempt > other.attempt,
							),
					)
					if (unresolved) return { _tag: "Recorded" as const }
					if (execution.status === "outcome_unknown") {
						const status = execution.cancelPending ? "cancelling" : "running"
						if (!execution.cancelPending && execution.phaseFailed)
							return { _tag: "Stop" as const }
						const failure = execution.phaseFailed
							? (yield* view(execution)).failure
							: null
						yield* db
							.update(executions)
							.set({
								status,
								failure: execution.phaseFailed ? execution.failure : null,
							})
							.where(where(key))
						yield* append(
							key,
							execution.sequence + 1,
							{ _tag: "State", status, failure },
							yield* Clock.currentTimeMillis,
						)
						return { _tag: "Retry" as const }
					}
					return execution.phaseFailed
						? { _tag: "Stop" as const }
						: { _tag: "Recorded" as const }
				}
				if (answer === "retry") {
					if (execution.phaseFailed) return { _tag: "Stop" as const }
					yield* retryCall(key, id)
					return { _tag: "Retry" as const }
				}
				if (answer !== undefined)
					return yield* Execution.Conflict.make({ id: key.id })
				yield* requestDecision(
					key,
					decisionId,
					call.retry === "idempotent" ? ["stop"] : ["retry", "stop"],
				)
				return {
					_tag: "Pending" as const,
					decisionId,
					afterSequence: (yield* row(key)).sequence,
				}
			}),
		)
	}, storage)

	const sending = Effect.fn("ExecutionStore.sending")(function* (
		key: Fence,
		id: Execution.CallId,
		admit?: Effect.Effect<
			void,
			| Paused
			| Execution.Forbidden
			| Execution.NotFound
			| Execution.Conflict
			| Execution.StorageError
		>,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				// Lock owners before the child. No outside I/O or waits may run here.
				if (admit !== undefined) yield* admit
				const execution = yield* checkFence(key)
				if (execution.status !== "running")
					return yield* Execution.Conflict.make({ id: key.id })
				const rows = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.id, id),
						),
					)
					.for("update")
				const value = Arr.head(rows)
				if (Option.isNone(value))
					return yield* Execution.NotFound.make({ id: key.id })
				const call = yield* callView(value.value)
				if (call.status === "completed" || call.status === "outcome_unknown")
					return call
				// A read retry gets a new attempt through readAttempt, never this one.
				if (call.status === "sending" && call.retry === "read_only")
					return yield* Execution.Conflict.make({ id: key.id })
				if (
					execution.phaseFailed &&
					!(call.status === "sending" && call.retry === "never")
				)
					return yield* Execution.Conflict.make({ id: key.id })
				const now = yield* Clock.currentTimeMillis
				const status = Execution.maySend(call.status, call.retry)
					? "sending"
					: "outcome_unknown"
				yield* db
					.update(executionCalls)
					.set({ status, generation: key.generation, updatedAt: now })
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.id, id),
						),
					)
				if (status === "outcome_unknown") {
					yield* db.update(executions).set({ status }).where(where(key))
					yield* append(
						key,
						execution.sequence + 1,
						{
							_tag: "State",
							status,
							failure: (yield* view(execution)).failure,
						},
						now,
					)
					yield* requestDecision(
						key,
						Execution.callDecisionId(call.id, execution.cancelEpoch),
						["retry", "stop"],
					)
				}
				return { ...call, status }
			}),
		)
	}, storage)
	/** A lost reply to a write is not a saved failure or permission to repeat it. */
	const markUnknown = Effect.fn("ExecutionStore.markUnknown")(function* (
		key: Fence,
		id: Execution.CallId,
		pause: boolean,
	) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const execution = yield* checkFence(key)
				const [call] = yield* db
					.select()
					.from(executionCalls)
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.executionId, key.id),
							eq(executionCalls.id, id),
						),
					)
					.for("update")
				if (call === undefined)
					return yield* Execution.NotFound.make({ id: key.id })
				if (!pause && call.retry !== "read_only")
					return yield* Execution.Conflict.make({ id: key.id })
				if (call.status === "completed" || call.status === "outcome_unknown")
					return
				if (call.status !== "sending")
					return yield* Execution.Conflict.make({ id: key.id })
				const now = yield* Clock.currentTimeMillis
				yield* db
					.update(executionCalls)
					.set({ status: "outcome_unknown", updatedAt: now })
					.where(
						and(
							eq(executionCalls.namespace, key.namespace),
							eq(executionCalls.id, id),
						),
					)
				if (pause && execution.status === "running") {
					yield* db
						.update(executions)
						.set({ status: "outcome_unknown" })
						.where(where(key))
					yield* append(
						key,
						execution.sequence + 1,
						{
							_tag: "State",
							status: "outcome_unknown",
							failure: (yield* view(execution)).failure,
						},
						now,
					)
				}
				if (
					pause &&
					(call.retry === "never" || call.retry === "idempotent") &&
					(execution.status === "running" ||
						execution.status === "outcome_unknown")
				)
					yield* requestDecision(
						key,
						Execution.callDecisionId(
							Execution.CallId.make(call.id),
							execution.cancelEpoch,
						),
						call.retry === "idempotent" ? ["stop"] : ["retry", "stop"],
					)
			}),
		)
	}, storage)
	const uncertain = (key: Fence, id: Execution.CallId) =>
		markUnknown(key, id, true)
	const incompleteRead = (key: Fence, id: Execution.CallId) =>
		markUnknown(key, id, false)
	/** Late results are saved. Only the current running attempt may publish completion. */
	const finishCall = Effect.fn("ExecutionStore.finishCall")(function* <
		E = never,
		R = never,
	>(
		key: Fence,
		id: Execution.CallId,
		result: Schema.Json,
		events: ReadonlyArray<
			Exclude<Execution.EventBody, { readonly _tag: "State" }>
		> = [],
		/** Database writes only. They also run for a late result, without state advancement. */
		writes: Effect.Effect<void, E, R> = Effect.void,
	) {
		return yield* sql
			.withTransaction(
				Effect.gen(function* () {
					const { execution, call, found, now } = yield* Effect.gen(
						function* () {
							for (const event of events) {
								if (Schema.is(Execution.EventBody.cases.State)(event))
									return yield* Execution.Conflict.make({ id: key.id })
							}
							const execution = yield* row(key, true)
							const rows = yield* db
								.select()
								.from(executionCalls)
								.where(
									and(
										eq(executionCalls.namespace, key.namespace),
										eq(executionCalls.executionId, key.id),
										eq(executionCalls.id, id),
									),
								)
								.for("update")
							const found = Arr.head(rows)
							if (Option.isNone(found))
								return yield* Execution.NotFound.make({ id: key.id })
							const call = yield* callView(found.value)
							if (call.status === "completed") {
								if (!sameJson(call.result, result))
									return yield* Execution.Conflict.make({ id: key.id })
							}
							if (call.status === "intended")
								return yield* Execution.Conflict.make({ id: key.id })
							const now = yield* Clock.currentTimeMillis
							if (call.status !== "completed")
								yield* db
									.update(executionCalls)
									.set({
										status: "completed",
										updatedAt: now,
										result: yield* seal(
											key,
											`call:${id}:result`,
											yield* Schema.encodeEffect(json)(result),
										),
									})
									.where(
										and(
											eq(executionCalls.namespace, key.namespace),
											eq(executionCalls.id, id),
										),
									)
							return { execution, call, found, now }
						},
					).pipe(storage)
					yield* writes
					return yield* Effect.gen(function* () {
						// Save late results, but never let an older attempt advance the step.
						const [latest] = yield* db
							.select({ id: executionCalls.id })
							.from(executionCalls)
							.where(
								and(
									eq(executionCalls.namespace, key.namespace),
									eq(executionCalls.executionId, key.id),
									eq(executionCalls.step, call.step),
								),
							)
							.orderBy(desc(executionCalls.attempt))
							.limit(1)
						if (
							key.generation !== execution.generation ||
							execution.status !== "running" ||
							execution.phaseFailed ||
							latest?.id !== id ||
							call.status === "outcome_unknown"
						) {
							// A past owner can wake the current owner, but cannot advance its state.
							// The terminal State event must stay last for cursor readers.
							if (
								call.status !== "completed" &&
								!Execution.isTerminal((yield* view(execution)).status)
							)
								yield* append(
									key,
									execution.sequence + 1,
									{
										_tag: "CallRecorded",
										callId: id,
										step: call.step,
										attempt: call.attempt,
									},
									now,
								)
							return false
						}
						if (found.value.completionSequence === null) {
							const completed: Execution.EventBody = {
								_tag: "StepCompleted",
								step: call.step,
								attempt: call.attempt,
							}
							for (const [index, event] of Arr.map(
								[...events, completed],
								(event, index) => [index, event] as const,
							))
								yield* append(key, execution.sequence + index + 1, event, now)
							yield* db
								.update(executionCalls)
								.set({
									completionSequence: execution.sequence + events.length + 1,
								})
								.where(
									and(
										eq(executionCalls.namespace, key.namespace),
										eq(executionCalls.id, id),
									),
								)
						}
						return (
							key.generation === execution.generation &&
							execution.status === "running"
						)
					}).pipe(storage)
				}),
			)
			.pipe(transactionFailures)
	})
	const call = Effect.fn("ExecutionStore.call")(function* (
		key: Key,
		id: Execution.CallId,
	) {
		const rows = yield* db
			.select()
			.from(executionCalls)
			.where(
				and(
					eq(executionCalls.namespace, key.namespace),
					eq(executionCalls.executionId, key.id),
					eq(executionCalls.id, id),
				),
			)
			.limit(1)
		return yield* Option.match(Arr.head(rows), {
			onNone: () => Effect.succeed(Option.none<Execution.Call>()),
			onSome: (row) => callView(row).pipe(Effect.asSome),
		})
	}, storage)
	const stepCall = Effect.fn("ExecutionStore.stepCall")(function* (
		key: Key,
		step: string,
		order: "first" | "latest",
	) {
		const rows = yield* db
			.select()
			.from(executionCalls)
			.where(
				and(
					eq(executionCalls.namespace, key.namespace),
					eq(executionCalls.executionId, key.id),
					eq(executionCalls.step, step),
				),
			)
			.orderBy(
				order === "first"
					? asc(executionCalls.attempt)
					: desc(executionCalls.attempt),
			)
			.limit(1)
		return yield* Option.match(Arr.head(rows), {
			onNone: () => Effect.succeed(Option.none<Execution.Call>()),
			onSome: (row) => callView(row).pipe(Effect.asSome),
		})
	}, storage)
	const latestCalls = Effect.fn("ExecutionStore.latestCalls")(function* (
		key: Key,
	) {
		const latest = db
			.selectDistinctOn([executionCalls.step])
			.from(executionCalls)
			.where(
				and(
					eq(executionCalls.namespace, key.namespace),
					eq(executionCalls.executionId, key.id),
				),
			)
			.orderBy(asc(executionCalls.step), desc(executionCalls.attempt))
			.as("latest_calls")
		const rows = yield* db.select().from(latest).orderBy(asc(latest.createdAt))
		return yield* Effect.forEach(rows, callView)
	}, storage)
	const calls = Effect.fn("ExecutionStore.calls")(function* (key: Key) {
		return yield* db
			.select()
			.from(executionCalls)
			.where(
				and(
					eq(executionCalls.namespace, key.namespace),
					eq(executionCalls.executionId, key.id),
				),
			)
			.orderBy(asc(executionCalls.createdAt))
			.pipe(Effect.flatMap((rows) => Effect.forEach(rows, callView)))
	}, storage)
	return Store.of({
		/** Read a saved receipt before work outside a transaction. The caller checks current access. */
		receipt: (
			namespace: string,
			commandKey: Execution.CommandKey,
			input: {
				readonly actor: CommandActor
				readonly body: Schema.Json
			},
		) =>
			findCommand(namespace, input.actor, commandKey, input.body).pipe(storage),
		accept,
		activate,
		submit,
		locate,
		get,
		load,
		loadMember,
		loadService,
		ownership,
		wake,
		notify,
		owned,
		/** Hold an owner row in the caller transaction. Admission does not depend on its runner generation. */
		hold: (key: Key) => row(key, "share").pipe(Effect.asVoid, storage),
		/** Hold a fence against takeover while changing a child, without taking the owner's write lock. */
		guard: (key: Fence) => checkFence(key, true).pipe(Effect.asVoid, storage),
		/** Hold this fence in the caller's transaction before reading related records. */
		lock: (key: Fence) => checkFence(key).pipe(Effect.asVoid, storage),
		takeOver,
		failPhase,
		commit,
		transition,
		events,
		cancel,
		finishCancellation,
		requestDecision,
		decision,
		decisionPending,
		decide,
		pending,
		acknowledge,
		defer,
		command,
		intent,
		readAttempt,
		writeAttempt,
		repeatCall,
		retryCall,
		recoverCall,
		sending,
		finishCall,
		uncertain,
		incompleteRead,
		call,
		firstCall: (key: Key, step: string) => stepCall(key, step, "first"),
		latestCall: (key: Key, step: string) => stepCall(key, step, "latest"),
		latestCalls,
		calls,
	})
})

export const layer = Layer.effect(Store, make)
