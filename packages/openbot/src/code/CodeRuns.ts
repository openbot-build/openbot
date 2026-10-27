import type { PgClient } from "@effect/sql-pg"
import {
	ChatConflict,
	CodeRunsApi,
	ExperienceStorageUnavailable,
	Settings as SettingsApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Layer,
	Match,
	Option,
	Order,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore,
	String as Str,
	pipe,
} from "effect"
import { ActionPolicy } from "../apps/ActionPolicy.ts"
import * as Bindings from "../apps/Bindings.ts"
import { Capabilities } from "../apps/Capabilities.ts"
import { Invocations, type Position } from "../apps/Invocations.ts"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import { Answer, Gate, remember } from "../capabilities/Gate.ts"
import { Work } from "../capabilities/Work.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { codeModeOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import type { Call, Settled } from "./Protocol.ts"
import { Sandbox } from "./Sandbox.ts"
import * as Stored from "./StoredCodeRuns.ts"
import * as Db from "../database/Database.ts"
import * as VaultCode from "../vaults/CodeMode.ts"
import { Vaults } from "../vaults/Vaults.ts"

/** What the Bot gets back from a program. */
export const ToolResult = Schema.Struct({
	run: Schema.String,
	result: CodeRunsApi.CodeResult,
	/** Each App call of the program, so the Bot knows what already happened. */
	calls: Schema.Array(
		Schema.Struct({
			index: Schema.Natural,
			binding: Schema.String,
			operationId: Schema.optionalKey(Schema.String),
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
	calls: Arr.map(run.calls, (call) => ({
		index: call.index,
		binding: call.binding,
		...(call.operationId === undefined
			? {}
			: call.operationId === undefined
				? undefined
				: { operationId: call.operationId }),
		outcome: call.outcome._tag,
	})),
})

/** A binding with the name that programs use, such as `calendar.list_events`. */
export interface Named {
	readonly alias: string
	readonly binding: Bindings.Binding
}

const slug = (text: string) => {
	const value = pipe(
		text,
		Str.toLowerCase,
		Str.replace(/[^a-z0-9]+/g, "_"),
		Str.replace(/^_+|_+$/g, ""),
	)
	return value.length === 0 || /^[0-9]/.test(value) ? "_" + value : value
}

/** Orders values by a text with `localeCompare`. */
const byText =
	<A>(text: (value: A) => string): Order.Order<A> =>
	(self, that) =>
		Str.localeCompare(text(that))(text(self))

const byConnection = byText(
	(binding: Bindings.Binding) => binding.source.connectionId,
)

/**
 * Gives each binding a short name. The first part names the connection, the second the
 * capability. The names depend only on the connections, so a new run gets the same names.
 */
export const name = (
	bindings: ReadonlyArray<Bindings.Binding>,
): ReadonlyArray<Named> => {
	const sorted = Arr.sort(
		bindings,
		Order.combineAll([
			byConnection,
			byText((binding: Bindings.Binding) => binding.source.kind),
			byText((binding: Bindings.Binding) => binding.source.name),
		]),
	)
	// The first binding of a connection gives the name of the connection.
	const connections = pipe(
		bindings,
		Arr.dedupeWith((a, b) => a.source.connectionId === b.source.connectionId),
		Arr.sort(byConnection),
		Arr.map((binding) => binding.source),
	)
	let groups: ReadonlyArray<string> = []
	let named: ReadonlyArray<Named> = []
	for (const connection of connections) {
		const base = slug(connection.connectionName)
		let group = base
		// `apps.call` is taken by the call that takes a full name.
		for (let n = 2; group === "call" || Arr.contains(groups, group); n++)
			group = base + "_" + n
		groups = [...groups, group]
		const own = Arr.filter(
			sorted,
			(binding) => binding.source.connectionId === connection.connectionId,
		)
		for (const binding of own) {
			const base =
				group +
				"." +
				slug(binding.source.name) +
				(binding.source.kind === "tool" ? "" : "_" + binding.source.kind)
			let alias = base
			for (let n = 2; Arr.some(named, (entry) => entry.alias === alias); n++)
				alias = base + "_" + n
			named = [...named, { alias, binding }]
		}
	}
	return named
}

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

/** The outcome of a call that does not wait for a decision. */
type Ended = Exclude<Stored.StoredCall["outcome"], { readonly _tag: "Waiting" }>

/** What the program gets for one recorded call. */
const settledOf = (call: Stored.StoredCall, outcome: Ended): Settled => {
	switch (outcome._tag) {
		case "Denied":
			return {
				index: call.index,
				ok: false,
				error: errorText(
					"AppCallDenied",
					"A decider did not allow this call: " + outcome.reason,
					call.operationId === undefined
						? undefined
						: { operationId: call.operationId },
				),
			}
		case "Done": {
			const result = outcome.result
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
							"The App needs more input. Answer it outside the program.",
							{
								...(call.operationId === undefined
									? {}
									: call.operationId === undefined
										? undefined
										: { operationId: call.operationId }),
								request: result.request,
							},
						),
					}
				case "Failed":
					return {
						index: call.index,
						ok: false,
						error: errorText("AppCallFailed", result.message, {
							...(call.operationId === undefined
								? {}
								: call.operationId === undefined
									? undefined
									: { operationId: call.operationId }),
							reason: result.reason,
						}),
					}
			}
		}
	}
}

const byIndex = Order.mapInput(
	Order.Number,
	(value: { readonly index: number }) => value.index,
)

/** How long one host may run a program before another host can take it over. */
const leaseFor = (settings: SettingsApi.CodeMode) => settings.timeoutMs + 60_000

/** The run with its result. */
const ended = (
	run: Stored.Run,
	result: CodeRunsApi.CodeResult,
): Stored.Run => ({
	...run,
	status: result._tag === "Completed" ? "Completed" : "Failed",
	result,
})

/** What a run becomes when the host stopped the program. */
const stopped = (
	run: Stored.Run,
	isBroken: boolean,
	isMismatch: boolean,
): Stored.Run =>
	isBroken
		? ended(run, {
				_tag: "Failed",
				reason: "Unavailable",
				message: "OpenBot could not handle an App call of the program.",
				logs: [],
			})
		: isMismatch
			? ended(run, {
					_tag: "Failed",
					reason: "ReplayMismatch",
					message:
						"The program made other App calls than the last time it ran, so OpenBot stopped it.",
					logs: [],
				})
			: Arr.some(run.calls, (call) => call.outcome._tag === "Waiting")
				? { ...run, status: "Waiting" }
				: ended(run, {
						_tag: "Failed",
						reason: "Unavailable",
						message: "OpenBot could not handle an App call of the program.",
						logs: [],
					})

export class CodeRuns extends Context.Service<
	CodeRuns,
	{
		/** The Code Mode settings, when the platform turned Code Mode on. */
		readonly settings: Effect.Effect<Option.Option<SettingsApi.CodeMode>>
		/** The Vault items that the Bot of the current work may use, with their names for programs. */
		readonly vault: Effect.Effect<ReadonlyArray<VaultCode.Entry>>
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
			chat: string,
			callId: string,
		) => Effect.Effect<Option.Option<Stored.Run>, Stored.ReadError>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Stored.Run, Stored.ReadError>
		readonly list: (
			owner: string,
			chat: string,
		) => Effect.Effect<ReadonlyArray<Stored.Run>, Stored.ReadError>
		/** Runs that a stopped host left behind. */
		readonly stale: Effect.Effect<
			ReadonlyArray<{
				readonly owner: string
				readonly id: string
				readonly chat: string
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
	| Vaults
	| Crypto.Crypto
> = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const vaults = yield* Vaults
	const shared = yield* Settings
	const sandbox = yield* Sandbox
	const crypto = yield* Crypto.Crypto
	const services: Bindings.Services = {
		db,
		secrets,
		capabilities: yield* Capabilities,
		invocations: yield* Invocations,
		policy: yield* ActionPolicy,
		gate: yield* Gate,
		crypto,
	}
	/** The Code Mode settings, when the platform turned Code Mode on. */
	const enabled = shared.platform.pipe(
		Effect.map(
			Option.flatMap((platform) => {
				const value = codeModeOf(platform.document)
				return value.enabled ? Option.some(value) : Option.none()
			}),
		),
		Failures.replace("The Code Mode settings could not be read", () =>
			ExperienceStorageUnavailable.make({}),
		),
	)
	const settings: typeof CodeRuns.Service.settings = enabled.pipe(
		// The list of tools shows no Code Mode while nobody can read its settings.
		// `Failures.replace` logged the failure.
		Effect.catchTag("ExperienceStorageUnavailable", () => Effect.succeedNone),
	)
	/** The Vault items of the Bot, or none when they could not be read. */
	const usableItems: Effect.Effect<
		Option.Option<ReadonlyArray<VaultCode.Entry>>
	> = Effect.gen(function* () {
		// The Work belongs to the current Turn of a Bot. Outside of one, no Bot may use
		// Vault items.
		const work = yield* Effect.serviceOption(Work)
		if (Option.isNone(work)) return Option.some([])
		return yield* vaults
			.usable(work.value.caller.organizationId, work.value.bot.id)
			.pipe(
				Effect.map((usable) => Option.some(VaultCode.aliases(usable))),
				Effect.catch((error) =>
					Effect.logWarning(
						"Could not read the Vault items of a Bot.",
						Cause.fail(error),
					).pipe(Effect.as(Option.none())),
				),
			)
	})
	const vault: typeof CodeRuns.Service.vault = usableItems.pipe(
		Effect.map(Option.getOrElse(() => [])),
	)
	const save = (owner: string, run: Stored.Run, leaseUntil: number | null) =>
		Stored.change(db, secrets, owner, run.id, () =>
			Option.some({ run, leaseUntil }),
		)

	/**
	 * Runs a program from the start. Recorded calls give their recorded results.
	 * A new call goes through the capability check. The run stops at the first call
	 * that waits for a decision. `leaseUntil` is the lease that this host holds on
	 * the run. Each write checks it, so a host whose lease ended and whose run another
	 * host took over does not write the run again.
	 */
	const execute = (
		position: Position,
		initial: Stored.Run,
		bindings: ReadonlyArray<Bindings.Binding>,
		limits: SettingsApi.CodeMode,
		leaseUntil: number,
	): Effect.Effect<Stored.Run, Stored.Error> =>
		Effect.gen(function* () {
			const named = name(bindings)
			const owned = yield* Ref.make(leaseUntil)
			// One write at a time, so each write sees the lease of the write before it.
			const permit = yield* Semaphore.make(1)
			/** Changes the stored run while this host holds its lease. `next` is the new lease. */
			const own = (
				next: number | null,
				update: (current: Stored.Run) => Stored.Run,
			) =>
				permit.withPermit(
					Effect.gen(function* () {
						const held = yield* Ref.get(owned)
						const changed = yield* Stored.change(
							db,
							secrets,
							position.owner,
							initial.id,
							(current, stored) =>
								current.status === "Running" && stored === held
									? Option.some({ run: update(current), leaseUntil: next })
									: Option.none(),
						)
						if (Option.isNone(changed))
							return yield* ChatConflict.make({
								message: "Another host runs this code run now.",
							})
						if (next !== null) yield* Ref.set(owned, next)
					}),
				)
			const lease = Effect.map(
				Clock.currentTimeMillis,
				(now) => now + leaseFor(limits),
			)
			const usable = yield* usableItems
			if (Option.isNone(usable)) {
				// The program must not run without the Vault items that it may name.
				const failed: Stored.Run = {
					...initial,
					status: "Failed",
					result: {
						_tag: "Failed",
						reason: "Unavailable",
						message: "OpenBot could not read the Vault items of the Bot.",
						logs: [],
					},
					updatedAt: yield* Clock.currentTimeMillis,
				}
				yield* own(null, () => failed)
				return failed
			}
			const items = usable.value
			const state = yield* Ref.make(initial)
			const mismatch = yield* Ref.make(false)
			// A storage failure stops the program. It must not look like a wait for a decision.
			const broken = yield* Ref.make(false)
			const store = (leaseUntil: number | null) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const run = { ...(yield* Ref.get(state)), updatedAt: now }
					yield* Ref.set(state, run)
					yield* own(leaseUntil, () => run)
				})
			const record = (call: Stored.StoredCall) =>
				Ref.update(state, (run) => ({
					...run,
					calls: pipe(
						run.calls,
						Arr.filter((entry) => entry.index !== call.index),
						Arr.append(call),
						Arr.sort(byIndex),
					),
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
						const entry = Arr.findFirst(
							named,
							(entry) => entry.alias === call.binding,
						)
						const args = Schema.decodeOption(
							Schema.fromJsonString(Schema.JsonObject),
						)(call.arguments)
						if (Option.isNone(entry) || Option.isNone(args)) {
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
						const plain = { ...entry.value.binding, name: entry.value.alias }
						// The arguments keep their Vault references, so the hash never depends on a secret.
						const argumentsHash = yield* Stored.argumentsHashOf(
							crypto,
							call.binding,
							args.value,
						)
						const recorded = Arr.findFirst(
							(yield* Ref.get(state)).calls,
							(stored) => stored.index === call.index,
						)
						if (
							Option.isSome(recorded) &&
							(recorded.value.binding !== call.binding ||
								recorded.value.argumentsHash !== argumentsHash)
						) {
							yield* Ref.set(mismatch, true)
							return Option.none()
						}
						if (
							Option.isSome(recorded) &&
							recorded.value.outcome._tag !== "Waiting"
						) {
							ready = [
								...ready,
								settledOf(recorded.value, recorded.value.outcome),
							]
							continue
						}
						const guarded = VaultCode.guard(
							vaults,
							initial.organizationId,
							items,
							plain,
							args.value,
						)
						if (Result.isFailure(guarded)) {
							ready = [
								...ready,
								{
									index: call.index,
									ok: false,
									error: errorText("VaultDenied", guarded.failure),
								},
							]
							continue
						}
						const binding = guarded.success.binding
						const callId = callIdOf(call.index)
						const base = {
							index: call.index,
							binding: call.binding,
							source: binding.source,
							argumentsHash,
						}
						if (Option.isSome(recorded)) {
							// The call waited for a decision. The App operation says what happened since.
							const operation = yield* services.invocations.pending(
								position,
								callId,
							)
							const status = Option.map(operation, (value) => value.status)
							// A read needs no decision. Its host stopped before it sent the call.
							if (Option.isNone(operation) && !binding.needsDecision) {
								send = [
									...send,
									{ call: recorded.value, binding, args: args.value },
								]
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
									...recorded.value,
									outcome: {
										_tag: "Denied",
										reason: "A decider did not allow it.",
									} as const,
								}
								yield* record(denied)
								ready = [...ready, settledOf(denied, denied.outcome)]
								continue
							}
							if (Option.contains(status, "Approved")) {
								send = [
									...send,
									{ call: recorded.value, binding, args: args.value },
								]
								continue
							}
							// The call ran before, and maybe a host stopped before it saved the result.
							const result = operation.value.result
							if (result !== null) {
								const done = {
									...recorded.value,
									outcome: { _tag: "Done", result } as const,
								}
								yield* record(done)
								ready = [...ready, settledOf(done, done.outcome)]
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
									explicit: guarded.success.references > 0,
									code: {
										run: initial.id,
										index: call.index,
										code: initial.code,
									},
								})
							: Answer.Allow()
						const operation = yield* services.invocations
							.pending(position, callId)
							.pipe(Effect.map(Option.map((value) => value.id)))
						const waiting: Stored.StoredCall = {
							...base,
							...Option.match(operation, {
								onNone: () => ({}),
								onSome: (operationId) => ({ operationId }),
							}),
							outcome: { _tag: "Waiting" },
						}
						yield* record(waiting)
						if (answer._tag !== "Allow") {
							// The program waits for the decision, also for a denial: when it
							// runs again, the call gets the reason. Until then, the tool call
							// of the program is pending.
							if (answer._tag === "Deny" && answer.request !== undefined)
								yield* remember(
									initial.callId,
									Answer.Pending({ request: answer.request }),
								)
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
									...(result.operationId === undefined
										? {}
										: { operationId: result.operationId }),
									outcome: { _tag: "Done", result } as const,
								})),
							),
						{ concurrency: 8 },
					)
					for (const call of sent) yield* record(call)
					if (sent.length > 0) yield* store(yield* lease)
					if (paused) return Option.none()
					return Option.some(
						Arr.sort(
							Arr.appendAll(
								ready,
								Arr.map(sent, (call) => settledOf(call, call.outcome)),
							),
							byIndex,
						),
					)
				})
			// When the Turn stops, the run keeps the calls that it made so far.
			// When the run is no longer ours, `own` does not save it.
			const cancelled = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const run: Stored.Run = {
					...(yield* Ref.get(state)),
					status: "Cancelled",
					result: {
						_tag: "Failed",
						reason: "Cancelled",
						message: "The program was stopped.",
						logs: [],
					},
					updatedAt: now,
				}
				yield* own(null, () => run).pipe(
					Background.logFailure(
						"A stopped Code Mode program could not be saved",
					),
				)
			})
			// A run with many slow App calls can take longer than its lease, so the lease
			// grows while the program runs. The heartbeat stops before the last write.
			const extend = Effect.flatMap(lease, (next) =>
				own(next, (current) => current),
			)
			const outcome = yield* Effect.gen(function* () {
				yield* Background.repeat(extend, {
					schedule: Schedule.spaced(Duration.millis(leaseFor(limits) / 3)),
					message: "The lease of a Code Mode program could not be extended",
				})
				return yield* sandbox.run(
					{
						code: initial.code,
						bindings: Arr.map(named, (entry) => entry.alias),
						vault: Arr.map(items, (entry) => ({
							alias: entry.alias,
							fields: entry.usable.item.fields,
						})),
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
									Cause.fail(error),
								).pipe(
									Effect.andThen(Ref.set(broken, true)),
									Effect.as(Option.none()),
								),
							),
						),
				)
			}).pipe(
				Effect.onInterrupt(() => cancelled),
				Effect.scoped,
			)
			const run = yield* Ref.get(state)
			const isBroken = yield* Ref.get(broken)
			const isMismatch = yield* Ref.get(mismatch)
			const next = Match.valueTags(outcome, {
				Done: (outcome) =>
					ended(run, {
						_tag: "Completed",
						value: outcome.value,
						logs: outcome.logs,
					}),
				Failed: (outcome) =>
					ended(run, {
						_tag: "Failed",
						reason: outcome.reason,
						message: outcome.message,
						logs: outcome.logs,
					}),
				Stopped: () => stopped(run, isBroken, isMismatch),
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
			// A read failure fails the start, so the tool call gets no run that says Code Mode is off.
			const limits = yield* enabled
			// The Work belongs to the current Turn of a Bot, and the capability checks read
			// it from the context too. A program outside of a Turn has no Bot to work for.
			const work = yield* Effect.serviceOption(Work)
			const now = yield* Clock.currentTimeMillis
			const id = yield* Stored.idOf(crypto, {
				...input.position,
				callId: input.callId,
			})
			const fresh: Stored.Run = {
				id: CodeRunsApi.CodeRunId.make(id),
				chat: input.position.chat,
				turn: input.position.turn,
				callId: input.callId,
				status: "Running",
				code: input.code,
				reason: input.reason,
				calls: [],
				result: null,
				createdAt: now,
				updatedAt: now,
				seed: yield* crypto.randomIntBetween(0, 2 ** 31, { halfOpen: true }),
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
			const leaseUntil = now + leaseFor(limits.value)
			const { run, created } = yield* Stored.insert(
				db,
				secrets,
				input.position.owner,
				fresh,
				leaseUntil,
			)
			// The same tool call ran before. Keep its run.
			if (!created) return run
			return yield* execute(
				input.position,
				run,
				input.bindings,
				limits.value,
				leaseUntil,
			)
		})

	const resume: typeof CodeRuns.Service.resume = (input) =>
		Effect.gen(function* () {
			const read = yield* Effect.result(enabled)
			const now = yield* Clock.currentTimeMillis
			const lease =
				now +
				leaseFor(
					pipe(
						Result.getOrElse(read, () => Option.none()),
						Option.getOrElse(() => SettingsApi.codeModeDefaults),
					),
				)
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
							: Arr.map(current.calls, (call) =>
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
			// The claim saved the decision. The run stays Running under the lease, so the
			// sweep of stale runs runs it again when the lease ends.
			if (Result.isFailure(read)) return yield* read.failure
			const limits = read.success
			const run = claimed.value
			const position: Position = {
				owner: input.owner,
				chat: run.chat,
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
					return yield* execute(position, run, bindings, limits.value, lease)
				}),
			)
			return Option.some(ended)
		})

	return CodeRuns.of({
		settings,
		vault,
		start,
		resume,
		forCall: (owner, chat, callId) =>
			Stored.forCall(db, secrets, owner, chat, callId),
		get: (owner, id) => Stored.get(db, secrets, owner, id),
		list: (owner, chat) => Stored.list(db, secrets, owner, chat),
		stale: Effect.flatMap(Clock.currentTimeMillis, (now) =>
			Stored.stale(db, now),
		),
	})
})

export const layer = Layer.effect(CodeRuns, make)
