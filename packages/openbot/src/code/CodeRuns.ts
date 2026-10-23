import { createHash, randomInt } from "node:crypto"
import type { PgClient } from "@effect/sql-pg"
import { CodeRunsApi, Settings as SettingsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Ref,
	Schema,
} from "effect"
import { ActionPolicy } from "../apps/ActionPolicy.ts"
import * as Bindings from "../apps/Bindings.ts"
import { Capabilities } from "../apps/Capabilities.ts"
import { Invocations, type Position } from "../apps/Invocations.ts"
import { Gate } from "../capabilities/Gate.ts"
import { Work } from "../capabilities/Work.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { codeModeOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import type { Call, Settled } from "./Protocol.ts"
import { Sandbox } from "./Sandbox.ts"
import * as Stored from "./StoredCodeRuns.ts"
import * as Db from "../database/Database.ts"

/** What the Bot gets back from a program. */
export const ToolResult = Schema.Struct({
	run: Schema.String,
	result: CodeRunsApi.CodeResult,
	/** Each App call of the program, so the Bot knows what already happened. */
	calls: Schema.Array(
		Schema.Struct({
			index: Schema.Natural,
			binding: Schema.String,
			operationId: Schema.String,
			outcome: Schema.Literals(["Waiting", "Denied", "Done"]),
		}),
	),
})
export type ToolResult = typeof ToolResult.Type

export const toolResult = (run: Stored.Run): ToolResult => ({
	run: run.id,
	result:
		run.result ??
		({
			_tag: "Failed",
			reason: "Cancelled",
			message: "The program stopped before it ended.",
			logs: [],
		} as const),
	calls: run.calls.map((call) => ({
		index: call.index,
		binding: call.binding,
		operationId: call.operationId,
		outcome: call.outcome._tag,
	})),
})

/** A binding with the name that programs use, such as `calendar.list_events`. */
export interface Named {
	readonly alias: string
	readonly binding: Bindings.Binding
}

const slug = (text: string) => {
	const value = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
	return value.length === 0 || /^[0-9]/.test(value) ? "_" + value : value
}

/**
 * Gives each binding a short name. The first part names the connection, the second the
 * capability. The names depend only on the connections, so a new run gets the same names.
 */
export const name = (
	bindings: ReadonlyArray<Bindings.Binding>,
): ReadonlyArray<Named> => {
	const connections = Arr.dedupe(
		bindings
			.map((binding) => binding.source)
			.toSorted((a, b) => a.connectionId.localeCompare(b.connectionId))
			.map((source) => source.connectionId),
	)
	let groups: ReadonlyArray<readonly [string, string]> = []
	for (const connectionId of connections) {
		const source = bindings.find(
			(binding) => binding.source.connectionId === connectionId,
		)!.source
		const base = slug(source.connectionName)
		let group = base
		// `apps.call` is taken by the call that takes a full name.
		for (
			let n = 2;
			group === "call" || groups.some(([, used]) => used === group);
			n++
		)
			group = base + "_" + n
		groups = [...groups, [connectionId, group]]
	}
	let named: ReadonlyArray<Named> = []
	for (const binding of bindings.toSorted(
		(a, b) =>
			a.source.connectionId.localeCompare(b.source.connectionId) ||
			a.source.kind.localeCompare(b.source.kind) ||
			a.source.name.localeCompare(b.source.name),
	)) {
		const group = groups.find(
			([connectionId]) => connectionId === binding.source.connectionId,
		)![1]
		const base =
			group +
			"." +
			slug(binding.source.name) +
			(binding.source.kind === "tool" ? "" : "_" + binding.source.kind)
		let alias = base
		for (let n = 2; named.some((entry) => entry.alias === alias); n++)
			alias = base + "_" + n
		named = [...named, { alias, binding }]
	}
	return named
}

const hashArguments = (binding: string, args: Schema.JsonObject) =>
	createHash("sha256")
		.update(JSON.stringify([binding, args]))
		.digest("hex")

const errorText = (
	name: string,
	message: string,
	details?: Schema.Json,
): string =>
	JSON.stringify({
		name,
		message,
		...(details === undefined ? {} : { details }),
	})

/** What the program gets for one recorded call. */
const settledOf = (call: Stored.StoredCall): Settled | undefined => {
	switch (call.outcome._tag) {
		case "Waiting":
			return undefined
		case "Denied":
			return {
				index: call.index,
				ok: false,
				error: errorText(
					"AppCallDenied",
					"A decider did not allow this call: " + call.outcome.reason,
					{ operationId: call.operationId },
				),
			}
		case "Done": {
			const result = call.outcome.result
			switch (result._tag) {
				case "Completed":
					return {
						index: call.index,
						ok: true,
						value: JSON.stringify(result.result),
					}
				case "InputRequired":
					return {
						index: call.index,
						ok: false,
						error: errorText(
							"AppInputRequired",
							"The App needs more input. Answer App operation " +
								call.operationId +
								" outside the program.",
							{ operationId: call.operationId, request: result.request },
						),
					}
				case "Failed":
					return {
						index: call.index,
						ok: false,
						error: errorText("AppCallFailed", result.message, {
							operationId: call.operationId,
							reason: result.reason,
						}),
					}
			}
		}
	}
}

/** How long one host may run a program before another host can take it over. */
const leaseFor = (settings: SettingsApi.CodeMode) => settings.timeoutMs + 60_000

export class CodeRuns extends Context.Service<
	CodeRuns,
	{
		/** The Code Mode settings, when the platform turned Code Mode on. */
		readonly settings: Effect.Effect<Option.Option<SettingsApi.CodeMode>>
		/**
		 * The first run of a program, in the Turn of the Bot. It ends when the program
		 * ends or when a call waits for a decision.
		 */
		readonly start: (input: {
			readonly position: Position
			readonly callId: string
			readonly code: string
			readonly reason: string
			readonly bindings: ReadonlyArray<Bindings.Binding>
		}) => Effect.Effect<Stored.Run, Stored.Error>
		/**
		 * Runs a waiting program again after a decision. `denied` gives the reason when
		 * the decider said no to the call at `index`. Answers none when another host runs it.
		 */
		readonly resume: (input: {
			readonly owner: string
			readonly id: string
			readonly decision?: {
				readonly index: number
				readonly allowed: boolean
				readonly reason?: string
			}
		}) => Effect.Effect<Option.Option<Stored.Run>, Stored.Error>
		readonly forCall: (
			owner: string,
			session: string,
			callId: string,
		) => Effect.Effect<Option.Option<Stored.Run>, Stored.ReadError>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Stored.Run, Stored.ReadError>
		readonly list: (
			owner: string,
			session: string,
		) => Effect.Effect<ReadonlyArray<Stored.Run>, Stored.ReadError>
		/** Runs that a stopped host left behind. */
		readonly stale: Effect.Effect<
			ReadonlyArray<{
				readonly owner: string
				readonly id: string
				readonly session: string
			}>,
			Stored.Error
		>
	}
>()("@openbot-build/openbot/code/CodeRuns") {}

export const make: Effect.Effect<
	typeof CodeRuns.Service,
	never,
	| PgClient.PgClient
	| Secrets
	| Settings
	| Sandbox
	| Capabilities
	| Invocations
	| ActionPolicy
	| Gate
> = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const shared = yield* Settings
	const sandbox = yield* Sandbox
	const services: Bindings.Services = {
		db,
		secrets,
		capabilities: yield* Capabilities,
		invocations: yield* Invocations,
		policy: yield* ActionPolicy,
		gate: yield* Gate,
	}
	const settings: typeof CodeRuns.Service.settings = shared.platform.pipe(
		Effect.map(
			Option.flatMap((platform) => {
				const value = codeModeOf(platform.document)
				return value.enabled ? Option.some(value) : Option.none()
			}),
		),
		Effect.orElseSucceed(() => Option.none()),
	)
	const save = (owner: string, run: Stored.Run, leaseUntil: number | null) =>
		Stored.change(db, secrets, owner, run.id, () =>
			Option.some({ run, leaseUntil }),
		)

	/**
	 * Runs a program from the start. Recorded calls give their recorded results.
	 * A new call goes through the capability check. The run stops at the first call
	 * that waits for a decision.
	 */
	const execute = (
		position: Position,
		initial: Stored.Run,
		bindings: ReadonlyArray<Bindings.Binding>,
		limits: SettingsApi.CodeMode,
	): Effect.Effect<Stored.Run, Stored.Error> =>
		Effect.gen(function* () {
			const named = name(bindings)
			const state = yield* Ref.make(initial)
			const mismatch = yield* Ref.make(false)
			// A storage failure stops the program. It must not look like a wait for a decision.
			const broken = yield* Ref.make(false)
			const store = (leaseUntil: number | null) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const run = { ...(yield* Ref.get(state)), updatedAt: now }
					yield* Ref.set(state, run)
					yield* save(position.owner, run, leaseUntil)
				})
			const lease = Effect.map(
				Clock.currentTimeMillis,
				(now) => now + leaseFor(limits),
			)
			const record = (call: Stored.StoredCall) =>
				Ref.update(state, (run) => ({
					...run,
					calls: [
						...run.calls.filter((entry) => entry.index !== call.index),
						call,
					].toSorted((a, b) => a.index - b.index),
				}))
			const callIdOf = (index: number) => initial.callId + ":" + index
			const answer = (calls: ReadonlyArray<Call>) =>
				Effect.gen(function* () {
					let ready: ReadonlyArray<Settled> = []
					let send: ReadonlyArray<{
						readonly call: Stored.StoredCall
						readonly binding: Bindings.Binding
						readonly args: Schema.JsonObject
					}> = []
					let paused = false
					for (const call of calls) {
						const entry = named.find((entry) => entry.alias === call.binding)
						const args = Schema.decodeOption(
							Schema.fromJsonString(Schema.JsonObject),
						)(call.arguments)
						if (entry === undefined || Option.isNone(args)) {
							ready = [
								...ready,
								{
									index: call.index,
									ok: false,
									error: errorText(
										"TypeError",
										"The call to " +
											call.binding +
											" has no App binding or no plain object as arguments.",
									),
								},
							]
							continue
						}
						// The invocation gets the program name, so it is the same in each run.
						const binding = { ...entry.binding, name: entry.alias }
						const argumentsHash = hashArguments(call.binding, args.value)
						const recorded = (yield* Ref.get(state)).calls.find(
							(stored) => stored.index === call.index,
						)
						if (
							recorded !== undefined &&
							(recorded.binding !== call.binding ||
								recorded.argumentsHash !== argumentsHash)
						) {
							yield* Ref.set(mismatch, true)
							return Option.none()
						}
						if (recorded !== undefined && recorded.outcome._tag !== "Waiting") {
							ready = [...ready, settledOf(recorded)!]
							continue
						}
						const callId = callIdOf(call.index)
						const base = {
							index: call.index,
							binding: call.binding,
							source: binding.source,
							argumentsHash,
						}
						if (recorded !== undefined) {
							// The call waited for a decision. The App operation says what happened since.
							const operation = yield* services.invocations.pending(
								position,
								callId,
							)
							const status = Option.map(operation, (value) => value.status)
							// A read needs no decision. Its host stopped before it sent the call.
							if (Option.isNone(operation) && !binding.needsDecision) {
								send = [...send, { call: recorded, binding, args: args.value }]
								continue
							}
							if (
								Option.isNone(operation) ||
								Option.contains(status, "PendingApproval")
							) {
								paused = true
								break
							}
							if (Option.contains(status, "Rejected")) {
								const denied = {
									...recorded,
									outcome: {
										_tag: "Denied",
										reason: "A decider did not allow it.",
									} as const,
								}
								yield* record(denied)
								ready = [...ready, settledOf(denied)!]
								continue
							}
							if (Option.contains(status, "Approved")) {
								send = [...send, { call: recorded, binding, args: args.value }]
								continue
							}
							// The call ran before, and maybe a host stopped before it saved the result.
							const result = operation.value.result
							if (result !== null) {
								const done = {
									...recorded,
									outcome: { _tag: "Done", result } as const,
								}
								yield* record(done)
								ready = [...ready, settledOf(done)!]
								continue
							}
							paused = true
							break
						}
						const answer = binding.needsDecision
							? yield* Bindings.decide(services, position, binding, {
									callId,
									arguments: args.value,
									reason: initial.reason,
									toolCallId: initial.callId,
									code: {
										run: initial.id,
										index: call.index,
										code: initial.code,
									},
								})
							: ("allow" as const)
						const operation = yield* services.invocations
							.pending(position, callId)
							.pipe(Effect.map(Option.map((value) => value.id)))
						const waiting: Stored.StoredCall = {
							...base,
							operationId: Option.getOrElse(operation, () => ""),
							outcome: { _tag: "Waiting" },
						}
						yield* record(waiting)
						if (answer === "pause") {
							paused = true
							break
						}
						send = [...send, { call: waiting, binding, args: args.value }]
					}
					yield* store(yield* lease)
					const sent = yield* Effect.forEach(
						send,
						({ call, binding, args }) =>
							Bindings.execute(
								services,
								position,
								binding,
								callIdOf(call.index),
								args,
							).pipe(
								Effect.map((result) => ({
									...call,
									operationId: result.operationId ?? call.operationId,
									outcome: { _tag: "Done", result } as const,
								})),
							),
						{ concurrency: 8 },
					)
					for (const call of sent) yield* record(call)
					if (sent.length > 0) yield* store(yield* lease)
					if (paused) return Option.none()
					return Option.some(
						[...ready, ...sent.map((call) => settledOf(call)!)].toSorted(
							(a, b) => a.index - b.index,
						),
					)
				})
			// When the Turn stops, the run keeps the calls that it made so far.
			const cancelled = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* save(
					position.owner,
					{
						...(yield* Ref.get(state)),
						status: "Cancelled",
						result: {
							_tag: "Failed",
							reason: "Cancelled",
							message: "The program was stopped.",
							logs: [],
						},
						updatedAt: now,
					},
					null,
				).pipe(Effect.ignore)
			})
			const outcome = yield* sandbox
				.run(
					{
						code: initial.code,
						bindings: named.map((entry) => entry.alias),
						seed: initial.seed,
						clock: initial.clock,
						limits: {
							timeoutMs: limits.timeoutMs,
							memoryBytes: limits.memoryMb * 1024 * 1024,
							outputBytes: limits.outputBytes,
						},
					},
					(calls) =>
						answer(calls).pipe(
							Effect.catch((error) =>
								Effect.logWarning(
									"A Code Mode call could not be handled.",
									error,
								).pipe(
									Effect.andThen(Ref.set(broken, true)),
									Effect.as(Option.none()),
								),
							),
						),
				)
				.pipe(Effect.onInterrupt(() => cancelled))
			const run = yield* Ref.get(state)
			const ended = (result: CodeRunsApi.CodeResult): Stored.Run => ({
				...run,
				status: result._tag === "Completed" ? "Completed" : "Failed",
				result,
			})
			const next: Stored.Run =
				outcome._tag === "Done"
					? ended({
							_tag: "Completed",
							value: outcome.value,
							logs: outcome.logs,
						})
					: outcome._tag === "Failed"
						? ended({
								_tag: "Failed",
								reason: outcome.reason,
								message: outcome.message,
								logs: outcome.logs,
							})
						: (yield* Ref.get(broken))
							? ended({
									_tag: "Failed",
									reason: "Unavailable",
									message:
										"OpenBot could not handle an App call of the program.",
									logs: [],
								})
							: (yield* Ref.get(mismatch))
								? ended({
										_tag: "Failed",
										reason: "ReplayMismatch",
										message:
											"The program made other App calls than the last time it ran, so OpenBot stopped it.",
										logs: [],
									})
								: run.calls.some((call) => call.outcome._tag === "Waiting")
									? { ...run, status: "Waiting" }
									: ended({
											_tag: "Failed",
											reason: "Unavailable",
											message:
												"OpenBot could not handle an App call of the program.",
											logs: [],
										})
			yield* Ref.set(state, next)
			yield* store(null)
			return yield* Ref.get(state)
		})

	/** The bindings of the owner, outside of a Turn. */
	const bindingsOf = (position: Position) =>
		Bindings.prepare(services, position, [], Option.none()).pipe(
			Effect.map(({ entries }) => entries),
		)

	const start: typeof CodeRuns.Service.start = (input) =>
		Effect.gen(function* () {
			const limits = yield* settings
			// The capability checks read the current Bot from the context too.
			const work = yield* Effect.serviceOption(Work)
			const now = yield* Clock.currentTimeMillis
			const id = Stored.idOf({ ...input.position, callId: input.callId })
			const fresh: Stored.Run = {
				id,
				session: input.position.session,
				turn: input.position.turn,
				callId: input.callId,
				status: "Running",
				code: input.code,
				reason: input.reason,
				calls: [],
				result: null,
				createdAt: now,
				updatedAt: now,
				seed: randomInt(0, 2 ** 31),
				clock: now,
				organizationId: Option.match(work, {
					onNone: () => "",
					onSome: (work) => work.caller.organizationId,
				}),
				userId: Option.match(work, {
					onNone: () => "",
					onSome: (work) => work.caller.userId,
				}),
			}
			if (Option.isNone(limits) || Option.isNone(work)) {
				const failed: Stored.Run = {
					...fresh,
					status: "Failed",
					result: {
						_tag: "Failed",
						reason: "Unavailable",
						message: Option.isNone(limits)
							? "Code Mode is off on this platform."
							: "The program has no Bot to work for.",
						logs: [],
					},
				}
				return (yield* Stored.insert(
					db,
					secrets,
					input.position.owner,
					failed,
					0,
				)).run
			}
			const { run, created } = yield* Stored.insert(
				db,
				secrets,
				input.position.owner,
				fresh,
				now + leaseFor(limits.value),
			)
			// The same tool call ran before. Keep its run.
			if (!created) return run
			return yield* execute(input.position, run, input.bindings, limits.value)
		})

	const resume: typeof CodeRuns.Service.resume = (input) =>
		Effect.gen(function* () {
			const limits = yield* settings
			const now = yield* Clock.currentTimeMillis
			const lease =
				now +
				leaseFor(Option.getOrElse(limits, () => SettingsApi.codeModeDefaults))
			const claimed = yield* Stored.change(
				db,
				secrets,
				input.owner,
				input.id,
				(current, leaseUntil) => {
					const free =
						current.status === "Waiting" ||
						(current.status === "Running" &&
							(leaseUntil === null || leaseUntil < now))
					if (!free) return Option.none()
					const decided =
						input.decision === undefined || input.decision.allowed
							? current.calls
							: current.calls.map((call) =>
									call.index === input.decision!.index &&
									call.outcome._tag === "Waiting"
										? {
												...call,
												outcome: {
													_tag: "Denied" as const,
													reason:
														input.decision!.reason ??
														"A decider did not allow it.",
												},
											}
										: call,
								)
					return Option.some({
						run: {
							...current,
							status: "Running" as const,
							calls: decided,
							updatedAt: now,
						},
						leaseUntil: lease,
					})
				},
			)
			if (Option.isNone(claimed)) return Option.none()
			const run = claimed.value
			const position: Position = {
				owner: input.owner,
				session: run.session,
				turn: run.turn,
			}
			if (Option.isNone(limits)) {
				const failed: Stored.Run = {
					...run,
					status: "Failed",
					result: {
						_tag: "Failed",
						reason: "Unavailable",
						message: "Code Mode is off on this platform.",
						logs: [],
					},
				}
				yield* save(input.owner, failed, null)
				return Option.some(failed)
			}
			const ended = yield* Effect.scoped(
				Effect.gen(function* () {
					const bindings = yield* bindingsOf(position)
					return yield* execute(position, run, bindings, limits.value)
				}),
			)
			return Option.some(ended)
		})

	return CodeRuns.of({
		settings,
		start,
		resume,
		forCall: (owner, session, callId) =>
			Stored.forCall(db, secrets, owner, session, callId),
		get: (owner, id) => Stored.get(db, secrets, owner, id),
		list: (owner, session) => Stored.list(db, secrets, owner, session),
		stale: Effect.flatMap(Clock.currentTimeMillis, (now) =>
			Stored.stale(db, now),
		),
	})
})

export const layer = Layer.effect(CodeRuns, make)
