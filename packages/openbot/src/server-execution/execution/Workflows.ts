import type * as Admission from "./Admission.ts"
import {
	type Caller,
	type ServiceCaller,
	type ServiceId,
	Execution,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Data,
	Deferred,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	type Scope,
} from "effect"
import type { WorkflowEngine } from "effect/workflow"
import type { Access, Authorize, Decide, define } from "./Engine.ts"
import type { Key } from "./Store.ts"

export type { Access, Authorize, Decide, DecisionCommand } from "./Engine.ts"

/** What a reader of the access rules of one workflow sees. */
export interface Registered {
	readonly admit?: Admission.Check
	readonly decide?: Decide
	readonly authorize: (
		key: Key,
		actor: Caller | ServiceCaller,
		access: Access,
	) => ReturnType<Authorize>
}

/** Who may use the executions of one workflow. */
export type Policy = Data.TaggedEnum<{
	/** People call it. A service caller gets Forbidden. */
	Public: {
		readonly authorize: Authorize
		readonly decide?: Decide
		readonly admit?: Admission.Check
	}
	/** One saved service calls it. People may only read or decide, when the policy says so. */
	Service: {
		readonly serviceId: ServiceId
		readonly authorize: (key: Key, access: Access) => ReturnType<Authorize>
		readonly admit?: Admission.Check
		readonly publicRead?: Authorize
		readonly publicDecision?: {
			readonly authorize: Authorize
			readonly decide: Decide
		}
	}
}>
export const Policy = Data.taggedEnum<Policy>()

/**
 * The handler of a workflow. The feature takes its services when it makes
 * this function. Only the context of the engine is left.
 */
export type Run = (
	key: Key,
	executionId: string,
) => Effect.Effect<
	void,
	Execution.Failure,
	WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | Scope.Scope
>

/** One workflow that a feature gives to the engine. */
export interface Contribution {
	/** The stored name is `workflow._tag`. Never change it. */
	readonly workflow: ReturnType<typeof define>
	/** The id of the feature, such as "chats". FeatureUnavailable names it. */
	readonly plugin: string
	/** The version of the stored steps of the workflow. It is 1 for now. */
	readonly journal: number
	readonly run: Run
	readonly policy: Policy
}

/** Two features gave a workflow with the same name. */
export class Duplicate extends Schema.TaggedError<
	Duplicate,
	{ readonly brand: unique symbol }
>()("ExecutionWorkflowDuplicate", {
	workflow: Schema.String,
	plugin: Schema.String,
	other: Schema.String,
}) {}

/** No loaded feature gives the workflow of this execution. */
export class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("ExecutionWorkflowUnavailable", {
	workflow: Schema.String,
	feature: Schema.String,
}) {}

export interface Service {
	/**
	 * Adds a workflow while the scope is open. When the scope closes, the
	 * access rules go at once. Then the release waits until no open engine
	 * holds the handler.
	 */
	readonly contribute: (
		contribution: Contribution,
	) => Effect.Effect<void, Duplicate, Scope.Scope>
	readonly get: (name: string) => Effect.Effect<Option.Option<Registered>>
	readonly require: (name: string) => Effect.Effect<Registered, Unavailable>
	readonly names: Effect.Effect<ReadonlyArray<string>>
	/** Every workflow that is in now. It does not seal. */
	readonly current: Effect.Effect<HashMap.HashMap<string, Contribution>>
	/** The engine takes the full set once. A contribution after this is a defect. */
	readonly seal: Effect.Effect<HashMap.HashMap<string, Contribution>>
	/** The engine holds these names while its scope is open. */
	readonly hold: (
		names: Iterable<string>,
	) => Effect.Effect<void, never, Scope.Scope>
}

export class Workflows extends Context.Service<Workflows, Service>()(
	"@openbot-build/openbot/server-execution/execution/Workflows",
) {}

interface Entry {
	readonly contribution: Contribution
	readonly registered: Registered
}

interface State {
	readonly entries: HashMap.HashMap<string, Entry>
	/** It only grows, so `require` can name the feature of a workflow that went away. */
	readonly owners: HashMap.HashMap<string, string>
	readonly live: HashMap.HashMap<string, Deferred.Deferred<void>>
	readonly sealed: boolean
}

/** Public callers and saved service callers have separate paths. */
const toRegistered = (policy: Policy): Registered =>
	Policy.$match(policy, {
		Public: (policy): Registered => ({
			...(policy.admit === undefined ? {} : { admit: policy.admit }),
			...(policy.decide === undefined ? {} : { decide: policy.decide }),
			authorize: (key, actor, access) =>
				actor.kind === "service"
					? Effect.fail(Execution.Forbidden.make({}))
					: policy.authorize(key, actor, access),
		}),
		Service: (policy): Registered => ({
			...(policy.admit === undefined ? {} : { admit: policy.admit }),
			...(policy.publicDecision === undefined
				? {}
				: { decide: policy.publicDecision.decide }),
			authorize: (key, actor, access) =>
				actor.kind !== "service"
					? policy.publicRead !== undefined && access === "read"
						? policy.publicRead(key, actor, access)
						: policy.publicDecision !== undefined && access === "decide"
							? policy.publicDecision.authorize(key, actor, access)
							: Effect.fail(Execution.Forbidden.make({}))
					: actor.serviceId !== policy.serviceId
						? Effect.fail(Execution.Forbidden.make({}))
						: policy.authorize(key, access),
		}),
	})

const make = Effect.gen(function* () {
	const state = yield* Ref.make<State>({
		entries: HashMap.empty(),
		owners: HashMap.empty(),
		live: HashMap.empty(),
		sealed: false,
	})
	const add = (contribution: Contribution) =>
		Effect.flatten(
			Ref.modify(
				state,
				(current): readonly [Effect.Effect<void, Duplicate>, State] => {
					const name = contribution.workflow._tag
					const found = HashMap.get(current.entries, name)
					if (Option.isSome(found))
						return [
							Effect.fail(
								Duplicate.make({
									workflow: name,
									plugin: contribution.plugin,
									other: found.value.contribution.plugin,
								}),
							),
							current,
						]
					if (current.sealed)
						return [
							Effect.die("A workflow was added after the engine started."),
							current,
						]
					return [
						Effect.void,
						{
							...current,
							entries: HashMap.set(current.entries, name, {
								contribution,
								registered: toRegistered(contribution.policy),
							}),
							owners: HashMap.set(current.owners, name, contribution.plugin),
						},
					]
				},
			),
		)
	/** The access rules go first. Then the release waits for the engine to let go. */
	const remove = (name: string) =>
		Ref.modify(state, (current) => [
			HashMap.get(current.live, name),
			{ ...current, entries: HashMap.remove(current.entries, name) },
		]).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: Deferred.await,
				}),
			),
		)
	const contribute = (contribution: Contribution) =>
		Effect.acquireRelease(add(contribution), () =>
			remove(contribution.workflow._tag),
		)
	const get = (name: string) =>
		Effect.map(Ref.get(state), (current) =>
			Option.map(
				HashMap.get(current.entries, name),
				(entry) => entry.registered,
			),
		)
	const require = (name: string) =>
		Effect.flatMap(Ref.get(state), (current) =>
			Option.match(HashMap.get(current.entries, name), {
				onNone: () =>
					Effect.fail(
						Unavailable.make({
							workflow: name,
							feature: Option.getOrElse(
								HashMap.get(current.owners, name),
								() => name,
							),
						}),
					),
				onSome: (entry) => Effect.succeed(entry.registered),
			}),
		)
	const names = Effect.map(Ref.get(state), (current) =>
		Arr.fromIterable(HashMap.keys(current.entries)),
	)
	const current = Effect.map(Ref.get(state), (saved) =>
		HashMap.map(saved.entries, (entry) => entry.contribution),
	)
	const seal = Ref.modify(state, (current) => [
		HashMap.map(current.entries, (entry) => entry.contribution),
		{ ...current, sealed: true },
	])
	const hold = (held: Iterable<string>) => {
		const list = Arr.fromIterable(held)
		return Effect.acquireRelease(
			Deferred.make<void>().pipe(
				Effect.tap((done) =>
					Ref.update(state, (current) => ({
						...current,
						live: Arr.reduce(list, current.live, (live, name) =>
							HashMap.set(live, name, done),
						),
					})),
				),
			),
			(done) =>
				Deferred.succeed(done, undefined).pipe(
					Effect.andThen(
						Ref.update(state, (current) => ({
							...current,
							live: Arr.reduce(list, current.live, (live, name) =>
								Option.exists(
									HashMap.get(live, name),
									(found) => found === done,
								)
									? HashMap.remove(live, name)
									: live,
							),
						})),
					),
				),
		).pipe(Effect.asVoid)
	}
	return Workflows.of({
		contribute,
		get,
		require,
		names,
		current,
		seal,
		hold,
	})
})

export const layer = Layer.effect(Workflows, make)
