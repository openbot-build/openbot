import type { Bot, Chat, ChatStore, Item, Turn } from "@openbot-build/core"
import type { Identity } from "@openbot-build/domain"
import {
	Array as Arr,
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
import type { Entry } from "../../apps-contract/apps/WorkflowTools.ts"
import type { Fence } from "../../server-execution/execution/Store.ts"
import type { Definition } from "../../tools-contract/chats/ToolDefinitions.ts"
import type { Gate } from "../capabilities/Gate.ts"
import type { Work } from "../capabilities/Work.ts"
import type * as ChatHost from "./ChatHost.ts"

/** One feature that a Turn uses. The Turn keeps the list in its workflow journal. */
export const Pin = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	settings: Schema.Json,
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
		Bot.ToolRegistration,
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

/** A feature that a hold keeps, with the settings of its pin. */
export interface Held {
	readonly pin: Pin
	readonly contribution: Contribution
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
	 * Holds every pinned feature until the scope closes. It holds all of them
	 * or none of them. It waits while one is absent. It fails only when a
	 * pinned feature has a different version.
	 */
	readonly hold: (
		pins: ReadonlyArray<Pin>,
	) => Effect.Effect<ReadonlyArray<Held>, FeatureVersionChanged, Scope.Scope>
	/** Holds every present feature with its settings now. For work with no pin. */
	readonly holdPresent: Effect.Effect<ReadonlyArray<Held>, never, Scope.Scope>
}

/** The Bot tools that features give to every Turn. */
export class BotFeatures extends Context.Service<BotFeatures, Service>()(
	"@openbot-build/openbot/conversation-contract/chats/BotFeatures",
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
			const missing = Arr.map(
				Arr.filter(found, ({ live }) => Option.isNone(live)),
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
				while (true) {
					const decision = yield* attempt(() => pins)
					if (decision._tag === "Held") return decision.held
					if (decision._tag === "Changed") return yield* decision.error
					// The wait holds nothing, so a release that waits for its holders cannot
					// wait for this Turn. The wait has no time limit, because the set of
					// features does not change while the server runs. At shutdown the engine
					// stops before the features close, so no Turn waits here then.
					const ids = decision.ids
					yield* until((current) =>
						Arr.every(ids, (id) => HashMap.has(current.live, id)),
					)
				}
			})
		/** The settings are read after the hold, so the hold takes one step. */
		const holdPresent = attempt((current) =>
			Arr.map(Arr.fromIterable(HashMap.values(current.live)), (live): Pin => ({
				id: live.contribution.id,
				version: live.contribution.version,
				settings: null,
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
 * The features of one server. A release does not wait: the execution engine
 * closes before the features, so no Turn runs at that time.
 */
export const layer = Layer.effect(BotFeatures, make({ drain: Duration.zero }))
