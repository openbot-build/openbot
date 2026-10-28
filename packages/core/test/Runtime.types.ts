import {
	Bot,
	Chat,
	ChatRuntime,
	ChatStore,
	ChatStoreRepository,
	Item,
	Plugin,
	PluginComposition,
	PluginState,
	Store,
	Turn,
} from "@openbot-build/core"
import { Context, Effect, Option, Schema } from "effect"
class DecodeDependency extends Context.Service<DecodeDependency, number>()(
	"@openbot-build/core/test/Runtime.types/DecodeDependency",
) {}
class EncodeDependency extends Context.Service<EncodeDependency, number>()(
	"@openbot-build/core/test/Runtime.types/EncodeDependency",
) {}
class PluginDependency extends Context.Service<PluginDependency, number>()(
	"@openbot-build/core/test/Runtime.types/PluginDependency",
) {}
type Assert<T extends true> = T
export const checkLiveChannels = (input: {
	readonly schema: Schema.Codec<
		number,
		Schema.Json,
		DecodeDependency,
		EncodeDependency
	>
	readonly persistence: ChatStore.Persistence
	readonly chat: Chat.Id
}) =>
	Effect.gen(function* () {
		const declaration = {
			scope: "state" as const,
			schema: input.schema,
		}
		const definition = yield* Store.define({
			stores: { counter: declaration },
			schemaVersion: "chat/1",
		})
		const construction = ChatStoreRepository.make({
			definition,
			persistence: input.persistence,
		})
		const store = yield* construction
		const plugin = Plugin.make({
			id: Plugin.Id.make("counter"),
			store: declaration,
		})(() =>
			Effect.succeed({
				tools: {},
				handlers: Context.empty(),
				beforeStep: () =>
					Effect.andThen(
						PluginDependency,
						Effect.fail("plugin-error" as const),
					),
			}),
		)
		const own = yield* PluginState.make({ store, plugin })
		const runtimeConstruction = ChatRuntime.make({ store, bot: { plugin } })
		const runtime = yield* runtimeConstruction
		const read = store.read(input.chat),
			items = store.items(input.chat, { order: "desc" })
		const modified = store.modifyEffect({
			chat: input.chat,
			update: (current) =>
				Effect.flatMap(PluginDependency, (value) =>
					value < 0
						? Effect.fail("update-error" as const)
						: Effect.succeed([
								value,
								Option.some({
									value: { ...current.state, counter: value },
								}),
							] as const),
				),
		})
		const execution = runtime.execute({ chat: input.chat, input: "input" })
		const delivery = runtime.deliver({ chat: input.chat, input: "input" })
		const ownUpdate = own.modify((value) => ({ result: value, value }))
		const checks: [
			Assert<
				DecodeDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				EncodeDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof runtimeConstruction>
					? true
					: false
			>,
			Assert<Effect.Services<typeof read> extends never ? true : false>,
			Assert<Effect.Services<typeof items> extends never ? true : false>,
			Assert<
				"update-error" extends Effect.Error<typeof modified> ? true : false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof modified> ? true : false
			>,
			Assert<Effect.Services<typeof execution> extends never ? true : false>,
			Assert<
				"plugin-error" extends Effect.Error<typeof execution> ? true : false
			>,
			Assert<
				EncodeDependency extends Effect.Services<typeof execution>
					? false
					: true
			>,
			Assert<Effect.Services<typeof delivery> extends never ? true : false>,
			Assert<
				"plugin-error" extends Effect.Error<typeof delivery> ? false : true
			>,
			Assert<
				Bot.Context extends Effect.Services<typeof ownUpdate> ? true : false
			>,
			Assert<
				ChatStore.ChatStoreError extends Effect.Error<typeof ownUpdate>
					? true
					: false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof ownUpdate>
					? false
					: true
			>,
			Assert<
				Effect.Success<typeof ownUpdate> extends Option.Option<number>
					? true
					: false
			>,
		] = [
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
		]
		return checks
	})

export const checkStoreUpdateTypes = (input: {
	readonly store: Plugin.StoreOperations<number>
	readonly effect: (
		value: Option.Option<number>,
	) => Effect.Effect<Plugin.StoreChange<number, number>>
	readonly promise: (
		value: Option.Option<number>,
	) => Promise<Plugin.StoreChange<number, number>>
}) => {
	// @ts-expect-error Store updates use a pure function, not an Effect.
	const effect = input.store.modify(input.effect)
	// @ts-expect-error Store updates use a pure function, not a Promise.
	const promise = input.store.modify(input.promise)
	return { effect, promise }
}

export const checkIdentities = ({
	chat,
	turn,
	item,
	seq,
	revision,
}: {
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly seq: Item.Seq
	readonly revision: Chat.Revision
}) => {
	// @ts-expect-error A Turn cannot identify a Chat.
	const wrongChat: Chat.Id = turn
	// @ts-expect-error An Item cannot identify a Turn.
	const wrongTurn: Turn.Id = item
	// @ts-expect-error A Chat cannot identify an Item.
	const wrongItem: Item.Id = chat
	// @ts-expect-error A model step cannot identify a Turn.
	const wrongStep: Turn.Id = 1
	// @ts-expect-error The place of an Item is not a Chat revision.
	const wrongRevision: Chat.Position = { chat, revision: seq }
	const position: Chat.Position = { chat, revision }
	const control: { readonly chat: Chat.Id; readonly turn: Turn.Id } = {
		chat,
		turn,
	}
	return {
		wrongChat,
		wrongTurn,
		wrongItem,
		wrongStep,
		wrongRevision,
		position,
		control,
	}
}

class ConstructionDependency extends Context.Service<
	ConstructionDependency,
	number
>()("@openbot-build/core/test/Runtime.types/ConstructionDependency") {}
export const checkHostConstructionChannels = (input: {
	readonly store: ChatStore.Store
	readonly chat: Chat.Id
}) =>
	Effect.gen(function* () {
		const hostPlugin = Plugin.make({ id: Plugin.Id.make("host-channels") })(
			() =>
				Effect.gen(function* () {
					const value = yield* ConstructionDependency
					if (value < 0)
						return yield* Effect.fail("host-construction-error" as const)
					return {
						tools: {},
						handlers: Context.empty(),
						beforeStep: () =>
							Effect.andThen(
								PluginDependency,
								Effect.fail("host-execution-error" as const),
							),
					}
				}),
		)
		const construction = ChatRuntime.make({
			store: input.store,
			bot: { hostPlugin },
		})
		const runtime = yield* construction
		const execution = runtime.execute({ chat: input.chat, input: "Continue" })
		const checks: [
			Assert<
				ConstructionDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				"host-construction-error" extends Effect.Error<typeof execution>
					? true
					: false
			>,
			Assert<Effect.Services<typeof execution> extends never ? true : false>,
			Assert<
				"host-execution-error" extends Effect.Error<typeof execution>
					? true
					: false
			>,
			Assert<
				ConstructionDependency extends Effect.Services<typeof execution>
					? false
					: true
			>,
		] = [true, true, true, true, true]
		return checks
	})
export const checkConstructionChannels = ({
	store,
	chat,
}: {
	readonly store: ChatStore.Store
	readonly chat: Chat.Id
}) =>
	Effect.gen(function* () {
		const plugin = Plugin.make({ id: Plugin.Id.make("constructed") })(() =>
			Effect.gen(function* () {
				const value = yield* ConstructionDependency
				if (value < 0) return yield* Effect.fail("construction-error" as const)
				return {
					tools: {},
					handlers: Context.empty(),
					beforeStep: () =>
						Effect.andThen(
							PluginDependency,
							Effect.fail("execution-error" as const),
						),
				}
			}),
		)
		const combined = PluginComposition.merge(
			plugin,
			PluginComposition.withStore(
				Plugin.make({ id: Plugin.Id.make("plain") })(() =>
					Effect.succeed({ tools: {}, handlers: Context.empty() }),
				),
				{ scope: "record", schema: Schema.String },
			),
		)
		const construction = ChatRuntime.make({
			store,
			bot: { plugin: combined },
		})
		const runtime = yield* construction
		const execution = runtime.execute({ chat, input: "input" })
		const checks: [
			Assert<
				ConstructionDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				Bot.Context extends Effect.Services<typeof construction> ? false : true
			>,
			Assert<Effect.Error<typeof construction> extends never ? true : false>,
			Assert<
				"construction-error" extends Effect.Error<typeof construction>
					? false
					: true
			>,
			Assert<
				ConstructionDependency extends Effect.Services<typeof execution>
					? false
					: true
			>,
			Assert<Effect.Services<typeof execution> extends never ? true : false>,
			Assert<
				"execution-error" extends Effect.Error<typeof execution> ? true : false
			>,
			Assert<
				"construction-error" extends Effect.Error<typeof execution>
					? true
					: false
			>,
		] = [true, true, true, true, true, true, true, true, true]
		return checks
	})

/** A registration gets the Turn context from the runner and all other services from its host. */
export const checkToolRegistrationChannels = (input: {
	readonly store: ChatStore.Store
	readonly chat: Chat.Id
}) =>
	Effect.gen(function* () {
		const registerTools = Effect.gen(function* () {
			yield* Bot.Context
			if ((yield* ConstructionDependency) < 0)
				return yield* Effect.fail("registration-failed" as const)
			if ((yield* PluginDependency) < 0)
				return yield* Effect.fail("tools-failed" as const)
			return { tools: {}, handlers: Context.empty() }
		})
		const construction = ChatRuntime.make({
			store: input.store,
			bot: { registerTools },
		})
		const runtime = yield* construction
		const execution = runtime.execute({ chat: input.chat, input: "go" })
		const checks: [
			Assert<
				ConstructionDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof construction>
					? true
					: false
			>,
			Assert<
				Bot.Context extends Effect.Services<typeof construction> ? false : true
			>,
			Assert<
				"registration-failed" extends Effect.Error<typeof execution>
					? true
					: false
			>,
			Assert<
				"tools-failed" extends Effect.Error<typeof execution> ? true : false
			>,
			Assert<Effect.Services<typeof execution> extends never ? true : false>,
		] = [true, true, true, true, true, true]
		return checks
	})
