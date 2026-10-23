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
import { Context, Effect, Option, Schema, Stream } from "effect"
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
			Effect.succeed((next, options) =>
				Stream.fromEffect(PluginDependency).pipe(
					Stream.flatMap(() => Stream.fail("plugin-error" as const)),
					Stream.concat(next(options)),
				),
			),
		)
		const own = yield* PluginState.make({ store, plugin })
		const runtime = yield* ChatRuntime.make({ store, bot: { plugin } })
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
		const ownUpdate = own.modifyEffect((value) =>
			Effect.flatMap(PluginDependency, (number) =>
				number < 0
					? Effect.fail("own-update-error" as const)
					: Effect.succeed([number, value] as const),
			),
		)
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
			Assert<Effect.Services<typeof read> extends never ? true : false>,
			Assert<Effect.Services<typeof items> extends never ? true : false>,
			Assert<
				"update-error" extends Effect.Error<typeof modified> ? true : false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof modified> ? true : false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof execution>
					? true
					: false
			>,
			Assert<
				"plugin-error" extends Effect.Error<typeof execution> ? true : false
			>,
			Assert<
				EncodeDependency extends Effect.Services<typeof execution>
					? false
					: true
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof delivery> ? true : false
			>,
			Assert<
				"plugin-error" extends Effect.Error<typeof delivery> ? false : true
			>,
			Assert<
				Bot.Context extends Effect.Services<typeof ownUpdate> ? true : false
			>,
			Assert<
				"own-update-error" extends Effect.Error<typeof ownUpdate> ? true : false
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
		]
		return checks
	})
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
					return (next, options) =>
						Stream.fromEffect(PluginDependency).pipe(
							Stream.flatMap(() =>
								Stream.fail("host-execution-error" as const),
							),
							Stream.concat(next(options)),
						)
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
				"host-construction-error" extends Effect.Error<typeof construction>
					? true
					: false
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof execution>
					? true
					: false
			>,
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
				return (next, options) =>
					Stream.fromEffect(PluginDependency).pipe(
						Stream.flatMap(() => Stream.fail("execution-error" as const)),
						Stream.concat(next(options)),
					)
			}),
		)
		const combined = PluginComposition.merge(
			plugin,
			PluginComposition.withStore(
				Plugin.make({ id: Plugin.Id.make("plain") })(() =>
					Effect.succeed((next, options) => next(options)),
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
					? false
					: true
			>,
			Assert<
				Bot.Context extends Effect.Services<typeof construction> ? false : true
			>,
			Assert<
				Effect.Error<typeof construction> extends "construction-error"
					? true
					: false
			>,
			Assert<
				"construction-error" extends Effect.Error<typeof construction>
					? true
					: false
			>,
			Assert<
				ConstructionDependency extends Effect.Services<typeof execution>
					? false
					: true
			>,
			Assert<
				PluginDependency extends Effect.Services<typeof execution>
					? true
					: false
			>,
			Assert<
				"execution-error" extends Effect.Error<typeof execution> ? true : false
			>,
			Assert<
				"construction-error" extends Effect.Error<typeof execution>
					? false
					: true
			>,
		] = [true, true, true, true, true, true, true, true, true]
		return checks
	})
