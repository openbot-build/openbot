import type { Identity } from "@openbot-build/domain/Identity"
import type {
	Bot,
	Chat,
	ChatStore,
	Item,
	Plugin,
	Turn,
} from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Order,
	Schema,
	Scope,
	Stream,
	SubscriptionRef,
} from "effect"
import type { Entry } from "@openbot-build/apps-contract/apps/WorkflowTools"
import type { Fence } from "@openbot-build/server-execution/Store"
import type { Definition } from "@openbot-build/tools-contract/ToolDefinitions"
import type { Gate } from "../capabilities/Gate.ts"
import type { Work } from "../capabilities/Work.ts"
import type * as ChatHost from "./ChatHost.ts"

/**
 * What a later phase of a Turn does when a feature of its pin is not on the
 * server, for example because an operator turned its plugin off.
 *
 * - `skip`: the phase goes on without the feature. Limits use it, so turning
 *   a limit off never stops a Turn.
 * - `wait`: the phase waits for the feature, but not longer than `millis`.
 *   Then it fails with `FeatureMissing`. Tool features use it, because a Turn
 *   may have saved calls of their tools.
 *
 * The pin keeps the policy, so it works also when the plugin is gone.
 */
export const Missing = Schema.Union([
	Schema.TaggedStruct("skip", {}),
	Schema.TaggedStruct("wait", {
		millis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	}),
])
export type Missing = typeof Missing.Type

/** Go on without the feature when it is not on the server. */
export const skip: Missing = { _tag: "skip" }

/** The time that `wait` gives when it gets no time. */
export const defaultWait = Duration.seconds(30)

/** Wait for the feature when it is not on the server, but not longer than `bound`. */
export const wait = (bound: Duration.Input = defaultWait): Missing => ({
	_tag: "wait",
	millis: Duration.toMillis(Duration.fromInputUnsafe(bound)),
})

/** One feature that a Turn uses. The Turn keeps the list in its workflow journal. */
export const Pin = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	settings: Schema.Json,
	missing: Missing,
})
export type Pin = typeof Pin.Type
export const Pins = Schema.Array(Pin)

/** Tells a Chat that a command of one of its sessions ended. */
export type Notify = (
	chat: Chat.Id,
	notice: {
		readonly text: string
		readonly ref: string
		readonly author: Turn.Author
	},
) => Effect.Effect<void>

/** The Chat data and commands that a Turn gives to each feature. */
export interface RegisterInput {
	readonly owner: typeof Identity.Service
	readonly namespace: string
	readonly read: (
		chat: Chat.Id,
	) => Effect.Effect<
		Chat.View<ChatHost.Values>,
		Chat.ChatNotFound | ChatStore.ChatStoreError
	>
	readonly items: (
		chat: Chat.Id,
		query: ChatStore.ItemQuery,
	) => Effect.Effect<
		ReadonlyArray<Item.Record>,
		Chat.ChatNotFound | ChatStore.ChatStoreError
	>
	readonly store: Pick<ChatStore.Store<ChatHost.Values>, "modifyEffect">
	readonly notify: Notify
	/** Tool names that are taken. Only a "last" feature gets a list that is not empty. */
	readonly occupied: ReadonlyArray<string>
}

/** The tools of one feature for one execution. */
export interface Feature {
	readonly register: (
		input: RegisterInput,
	) => Effect.Effect<
		Bot.ToolRegistration<{}, FeatureStopped>,
		never,
		Bot.Context | Work | Scope.Scope
	>
	/** Gives back one saved tool by its name, without the list for the model. */
	readonly restoreTool?: (
		input: Pick<RegisterInput, "notify">,
		name: string,
		work: typeof Work.Service,
	) => Effect.Effect<Bot.ToolRegistration>
}

/**
 * A feature ended the Turn, for example at a limit. `cause` is the typed
 * failure of the feature, and `category` is the failure category of that
 * cause, such as `limited` for a limit.
 */
export class FeatureStopped extends Schema.TaggedError<
	FeatureStopped,
	{ readonly brand: unique symbol }
>()(
	"BotFeatureStopped",
	{
		feature: Schema.String,
		category: Execution.Category,
		cause: Schema.Defect(),
	},
	// The type is written out, because the class can not name itself here.
	Execution.category(
		(error: { readonly category: Execution.Category }) => error.category,
	),
) {
	override get message() {
		return `The bot feature ${this.feature} stopped the Turn.`
	}
}

/** A feature made from a Bot plugin of `core`. It needs no input and only a scope. */
export interface PluginFeature extends Feature {
	readonly register: (
		input?: RegisterInput,
	) => Effect.Effect<
		Bot.ToolRegistration<{}, FeatureStopped>,
		never,
		Scope.Scope
	>
}

/**
 * The hooks of a Bot plugin of `core` as a feature. A failure of a hook, or
 * the error of its time limit, becomes `FeatureStopped` with the failure as
 * its cause. Tools, handlers and instructions stay as they are.
 */
export const fromPlugin = <E>(
	feature: string,
	plugin: Plugin.Plugin<{}, E>,
): PluginFeature => {
	const stop = (cause: E) =>
		FeatureStopped.make({
			feature,
			category: Option.getOrElse(
				Execution.categoryOf(cause),
				() => "unavailable" as const,
			),
			cause,
		})
	return {
		register: () =>
			Effect.map(
				plugin.register,
				({
					beforeStep,
					afterStep,
					timeLimit,
					...rest
				}): Bot.ToolRegistration<{}, FeatureStopped> => ({
					...rest,
					...(beforeStep === undefined
						? {}
						: {
								beforeStep: (input) => Effect.mapError(beforeStep(input), stop),
							}),
					...(afterStep === undefined
						? {}
						: {
								afterStep: (input) => Effect.mapError(afterStep(input), stop),
							}),
					...(timeLimit === undefined
						? {}
						: {
								timeLimit: {
									duration: timeLimit.duration,
									error: (history) => stop(timeLimit.error(history)),
								},
							}),
				}),
			),
	}
}

/** What a feature gives to every Turn while its scope is open. */
export interface Contribution {
	/** A fixed name that Turn journals keep. Never change it. */
	readonly id: string
	/** Make it higher only when an old Turn cannot replay with the new code. */
	readonly version: number
	/** The merge order. The host is 0 and the execution controls are 30. */
	readonly order: number
	/** A "last" feature is built after all others, and gets the names that are taken. */
	readonly build: "normal" | "last"
	/** The feature is also used in review Chats. */
	readonly review: boolean
	/** Names of saved tool calls that only this feature gives back (see `Feature.restoreTool`). */
	readonly restores: ReadonlyArray<string>
	/** What a later phase does when the feature is gone. The pin keeps it. */
	readonly missing: Missing
	/** The settings that the pin keeps, for example the limits of a limiter. */
	readonly settings: Effect.Effect<Schema.Json>
	/**
	 * Makes the tools of one execution. Each Turn phase calls it again for its
	 * own fence, with the Gate of that phase.
	 */
	readonly prepare: (
		fence: Fence,
		settings: Schema.Json,
	) => Effect.Effect<Feature, never, Gate | Scope.Scope>
	/** Gives back a saved tool from its definition. */
	readonly restore?: (
		fence: Fence,
		definition: Definition,
	) => Option.Option<Entry>
}

/** A contribution whose features come from Bot plugins of `core` (see `fromPlugin`). */
export interface PluginContribution extends Contribution {
	readonly prepare: (
		fence: Fence,
		settings: Schema.Json,
	) => Effect.Effect<PluginFeature, never, Scope.Scope>
}

/** A feature that a hold keeps, with the settings of its pin. */
export interface Held {
	readonly pin: Pin
	readonly contribution: Contribution
}

/**
 * A Turn waited for features of its pin with the policy `wait`, and they did
 * not come back in time. Its category is `unavailable`, so a client can try
 * again later.
 */
export class FeatureMissing extends Schema.TaggedError<
	FeatureMissing,
	{ readonly brand: unique symbol }
>()(
	"BotFeatureMissing",
	{ ids: Schema.Array(Schema.String) },
	Execution.category("unavailable"),
) {
	override get message() {
		return `The bot features ${Arr.join(this.ids, ", ")} are not on the server.`
	}
}

/** Two features have the same id. */
export class DuplicateFeature extends Schema.TaggedError<
	DuplicateFeature,
	{ readonly brand: unique symbol }
>()("DuplicateBotFeature", { id: Schema.String }) {}

/** A Turn kept a version of a feature that the server does not have now. */
export class FeatureVersionChanged extends Schema.TaggedError<
	FeatureVersionChanged,
	{ readonly brand: unique symbol }
>()("BotFeatureVersionChanged", {
	id: Schema.String,
	pinned: Schema.Int,
	present: Schema.Int,
}) {}

export interface Service {
	/** Adds a feature until the scope closes. A second feature with the same id fails. */
	readonly contribute: (
		contribution: Contribution,
	) => Effect.Effect<void, DuplicateFeature, Scope.Scope>
	/** The present features, with their settings now, in merge order. */
	readonly snapshot: Effect.Effect<ReadonlyArray<Pin>>
	/**
	 * Holds the pinned features until the scope closes. A pinned feature with
	 * a different version fails the hold. An absent feature follows the
	 * `missing` policy of its pin: `skip` leaves it out, and `wait` waits,
	 * holding nothing, until the bound of the pin. Then the hold fails with
	 * `FeatureMissing`. The hold holds all the features that it gives, or
	 * none.
	 */
	readonly hold: (
		pins: ReadonlyArray<Pin>,
	) => Effect.Effect<
		ReadonlyArray<Held>,
		FeatureVersionChanged | FeatureMissing,
		Scope.Scope
	>
	/** Holds every present feature with its settings now. For work with no pin. */
	readonly holdPresent: Effect.Effect<ReadonlyArray<Held>, never, Scope.Scope>
}

/** The Bot tools that features give to every Turn. */
export class BotFeatures extends Context.Service<BotFeatures, Service>()(
	"@openbot-build/conversation-contract/chats/BotFeatures",
) {}

/** Merge order: the order number first, then the id. */
export const contributionOrder: Order.Order<Contribution> = Order.combine(
	Order.mapInput(
		Order.Number,
		(contribution: Contribution) => contribution.order,
	),
	Order.mapInput(Order.String, (contribution: Contribution) => contribution.id),
)
export const byOrder: Order.Order<Held> = Order.mapInput(
	contributionOrder,
	(held: Held) => held.contribution,
)

interface Live {
	readonly serial: number
	readonly contribution: Contribution
}

interface State {
	readonly live: HashMap.HashMap<string, Live>
	/** For each contribution, the number of holds on it now. */
	readonly holders: HashMap.HashMap<number, number>
	readonly serial: number
}

type Decision =
	| { readonly _tag: "Held"; readonly held: ReadonlyArray<Held> }
	| { readonly _tag: "Changed"; readonly error: FeatureVersionChanged }
	| { readonly _tag: "Missing"; readonly ids: ReadonlyArray<string> }

const changeHolders = (
	holders: HashMap.HashMap<number, number>,
	serials: ReadonlyArray<number>,
	by: number,
) =>
	Arr.reduce(serials, holders, (current, serial) =>
		HashMap.modify(current, serial, (count) => count + by),
	)

/**
 * Keeps the features in memory. A release takes the feature out of new holds
 * at once. Then it waits for the present holds, but not longer than `drain`.
 */
export const make = (options: { readonly drain: Duration.Input }) =>
	Effect.gen(function* () {
		const drain = Duration.fromInputUnsafe(options.drain)
		const state = yield* SubscriptionRef.make<State>({
			live: HashMap.empty(),
			holders: HashMap.empty(),
			serial: 0,
		})
		/** Runs when the state first matches, the present state included. */
		const until = (matches: (current: State) => boolean) =>
			SubscriptionRef.changes(state).pipe(
				Stream.filter(matches),
				Stream.runHead,
				Effect.asVoid,
			)
		const holdersOf = (current: State, serial: number) =>
			Option.getOrElse(HashMap.get(current.holders, serial), () => 0)

		const add = (contribution: Contribution) =>
			Effect.flatten(
				SubscriptionRef.modify(
					state,
					(
						current,
					): readonly [Effect.Effect<number, DuplicateFeature>, State] =>
						HashMap.has(current.live, contribution.id)
							? [
									Effect.fail(DuplicateFeature.make({ id: contribution.id })),
									current,
								]
							: [
									Effect.succeed(current.serial),
									{
										live: HashMap.set(current.live, contribution.id, {
											serial: current.serial,
											contribution,
										}),
										holders: HashMap.set(current.holders, current.serial, 0),
										serial: current.serial + 1,
									},
								],
				),
			)
		const remove = (id: string, serial: number) =>
			Effect.gen(function* () {
				yield* SubscriptionRef.update(state, (current) => ({
					...current,
					live: HashMap.remove(current.live, id),
				}))
				const holders = holdersOf(yield* SubscriptionRef.get(state), serial)
				if (holders > 0) {
					const done = yield* until(
						(current) => holdersOf(current, serial) === 0,
					).pipe(Effect.timeoutOption(drain))
					if (Option.isNone(done))
						yield* Effect.logWarning(
							"A bot feature went away while Turns still held it.",
						).pipe(
							Effect.annotateLogs({
								feature: id,
								holders: holdersOf(yield* SubscriptionRef.get(state), serial),
							}),
						)
				}
				yield* SubscriptionRef.update(state, (current) => ({
					...current,
					holders: HashMap.remove(current.holders, serial),
				}))
			})
		const contribute = (contribution: Contribution) =>
			Effect.acquireRelease(add(contribution), (serial) =>
				remove(contribution.id, serial),
			).pipe(Effect.asVoid)

		const snapshot = Effect.gen(function* () {
			const current = yield* SubscriptionRef.get(state)
			const present = Arr.sort(
				Arr.map(
					Arr.fromIterable(HashMap.values(current.live)),
					(live) => live.contribution,
				),
				contributionOrder,
			)
			return yield* Effect.forEach(present, (contribution) =>
				Effect.map(contribution.settings, (settings): Pin => ({
					id: contribution.id,
					version: contribution.version,
					settings,
					missing: contribution.missing,
				})),
			)
		})

		const decide = (
			current: State,
			pins: ReadonlyArray<Pin>,
		): readonly [Decision, State] => {
			const found = Arr.map(pins, (pin) => ({
				pin,
				live: HashMap.get(current.live, pin.id),
			}))
			const changed = Arr.findFirst(found, ({ pin, live }) =>
				Option.filter(
					live,
					(value) => value.contribution.version !== pin.version,
				).pipe(
					Option.map((value) =>
						FeatureVersionChanged.make({
							id: pin.id,
							pinned: pin.version,
							present: value.contribution.version,
						}),
					),
				),
			)
			if (Option.isSome(changed))
				return [{ _tag: "Changed", error: changed.value }, current]
			// An absent feature with the policy `skip` is left out of the hold.
			const missing = Arr.map(
				Arr.filter(
					found,
					({ pin, live }) => Option.isNone(live) && pin.missing._tag === "wait",
				),
				({ pin }) => pin.id,
			)
			if (missing.length > 0)
				return [{ _tag: "Missing", ids: missing }, current]
			const held = Arr.getSomes(
				Arr.map(found, ({ pin, live }) =>
					Option.map(live, (value) => ({ pin, value })),
				),
			)
			return [
				{
					_tag: "Held",
					held: Arr.sort(
						Arr.map(held, ({ pin, value }): Held => ({
							pin,
							contribution: value.contribution,
						})),
						byOrder,
					),
				},
				{
					...current,
					holders: changeHolders(
						current.holders,
						Arr.map(held, ({ value }) => value.serial),
						1,
					),
				},
			]
		}
		const serialsOf = (current: State, held: ReadonlyArray<Held>) =>
			Arr.getSomes(
				Arr.map(held, (entry) =>
					Option.map(
						HashMap.get(current.live, entry.contribution.id),
						(live) => live.serial,
					),
				),
			)
		/** One try. A hold and its finalizer start together, so no count is lost. */
		const attempt = (pins: (current: State) => ReadonlyArray<Pin>) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const scope = yield* Effect.scope
					const result = yield* SubscriptionRef.modify(state, (current) => {
						const [decision, next] = decide(current, pins(current))
						return [
							{
								decision,
								serials:
									decision._tag === "Held"
										? serialsOf(current, decision.held)
										: [],
							},
							next,
						] as const
					})
					if (result.decision._tag === "Held")
						yield* Scope.addFinalizer(
							scope,
							SubscriptionRef.update(state, (current) => ({
								...current,
								holders: changeHolders(current.holders, result.serials, -1),
							})),
						)
					return result.decision
				}),
			)
		const hold = (pins: ReadonlyArray<Pin>) =>
			Effect.gen(function* () {
				if (pins.length === 0) return []
				const start = yield* Clock.currentTimeMillis
				while (true) {
					const decision = yield* attempt(() => pins)
					if (decision._tag === "Held") return decision.held
					if (decision._tag === "Changed") return yield* decision.error
					// The wait holds nothing, so a release that waits for its holders cannot
					// wait for this Turn. An operator can turn a plugin off while Turns
					// run, so the wait ends at the first bound of the absent features.
					const ids = decision.ids
					const bound = Arr.reduce(
						Arr.filter(pins, (pin) => Arr.contains(ids, pin.id)),
						Number.POSITIVE_INFINITY,
						(least, pin) =>
							pin.missing._tag === "wait"
								? Math.min(least, pin.missing.millis)
								: least,
					)
					const left = start + bound - (yield* Clock.currentTimeMillis)
					if (left <= 0) return yield* FeatureMissing.make({ ids })
					yield* until((current) =>
						Arr.every(ids, (id) => HashMap.has(current.live, id)),
					).pipe(Effect.timeoutOption(Duration.millis(left)))
				}
			})
		/** The settings are read after the hold, so the hold takes one step. */
		const holdPresent = attempt((current) =>
			Arr.map(Arr.fromIterable(HashMap.values(current.live)), (live): Pin => ({
				id: live.contribution.id,
				version: live.contribution.version,
				settings: null,
				missing: live.contribution.missing,
			})),
		).pipe(
			Effect.flatMap((decision) =>
				decision._tag === "Held"
					? Effect.forEach(decision.held, (held) =>
							Effect.map(held.contribution.settings, (settings): Held => ({
								...held,
								pin: { ...held.pin, settings },
							})),
						)
					: Effect.die("A hold of the present features found a change."),
			),
		)
		return BotFeatures.of({ contribute, snapshot, hold, holdPresent })
	})

/**
 * The features of one server. A release does not wait. At shutdown the
 * execution engine closes before the features, so no Turn runs at that time.
 * A feature plugin can also restart while Turns run, for example when its
 * config changes. A Turn keeps the feature that it built.
 */
export const layer = Layer.effect(BotFeatures, make({ drain: Duration.zero }))
