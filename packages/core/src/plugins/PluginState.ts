import { Effect, Option, Record as Rec } from "effect"
import * as Chat from "../chat/Chat.ts"
import * as Bot from "../bot/Bot.ts"
import type * as Plugin from "./Plugin.ts"
import type * as ChatStore from "../store/ChatStore.ts"

export const make = <P, D extends Plugin.StateDeclaration>(input: {
	readonly store: Pick<ChatStore.Store<P>, "read" | "modifyEffect">
	readonly plugin: Plugin.Definition & {
		readonly store: { readonly definition: D }
	}
}): Effect.Effect<Plugin.Store<D, Chat.ChatError, Bot.Context>> =>
	Effect.gen(function* () {
		type A = D["schema"]["Type"]
		type Operations = Plugin.StoreOperations<A, Chat.ChatError, Bot.Context>
		const key = input.plugin.id
		const scoped = (view: Chat.View<P>) =>
			input.plugin.store.definition.scope === "state"
				? view.state
				: view.chat.business
		// The stored record type does not know the type of the plugin store's codec.
		const read = (view: Chat.View<P>): Option.Option<A> =>
			Rec.get(scoped(view), key) as Option.Option<A>
		const replace = (
			view: Chat.View<P>,
			data: Option.Option<A>,
		): ChatStore.Mutation<P> => {
			const value = Option.match(data, {
				onNone: () => Rec.remove(scoped(view), key),
				onSome: (data) => ({ ...scoped(view), [key]: data }),
			})
			return input.plugin.store.definition.scope === "state"
				? { value: value as Chat.View<P>["state"] }
				: { chat: { business: value } }
		}
		const snapshot: Operations["snapshot"] = Effect.gen(function* () {
			const context = yield* Bot.Context,
				at = yield* context.at,
				view = yield* input.store.read(at.chat)
			return {
				at: Chat.position(view.chat),
				value: read(view),
			}
		})
		const modify: Operations["modify"] = (f) =>
			Effect.gen(function* () {
				const context = yield* Bot.Context,
					at = yield* context.at
				const changed = yield* input.store.modifyEffect({
					chat: at.chat,
					update: (current) =>
						Effect.sync(() => {
							const change = f(read(current))
							return [
								change.result,
								change.value === undefined
									? Option.none()
									: Option.some(replace(current, change.value)),
							] as const
						}),
				})
				return changed.result
			})
		return {
			definition: input.plugin.store.definition,
			snapshot,
			get: Effect.map(snapshot, ({ value }) => value),
			setAt: (request) =>
				Effect.gen(function* () {
					const context = yield* Bot.Context,
						at = yield* context.at
					if (at.chat !== request.base.chat)
						return yield* Chat.ChatError.make({
							reason: "state-conflict",
							message: "The plugin store is bound to a different Chat",
						})
					const { view } = yield* input.store.modifyEffect({
						chat: at.chat,
						expectedRevision: request.base.revision,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some(replace(current, request.value)),
							] as const),
					})
					return view.chat
				}),
			modify,
		}
	})
