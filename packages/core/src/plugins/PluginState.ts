import { Effect, Option, Record as EffectRecord } from "effect"
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
		const read = (view: Chat.View<P>): Option.Option<A> =>
			Option.fromUndefinedOr(scoped(view)[key] as A | undefined)
		const replace = (
			view: Chat.View<P>,
			data: Option.Option<A>,
		): ChatStore.Mutation<P> => {
			const value = Option.match(data, {
				onNone: () => EffectRecord.remove(scoped(view), key),
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
		const modifySomeEffect: Operations["modifySomeEffect"] = (f) =>
			Effect.gen(function* () {
				const context = yield* Bot.Context,
					at = yield* context.at
				const changed = yield* input.store.modifyEffect({
					chat: at.chat,
					update: (current) =>
						f(read(current)).pipe(
							Effect.map(
								([result, next]) =>
									[
										result,
										Option.map(next, (data) => replace(current, data)),
									] as const,
							),
						),
				})
				return changed.result
			})
		const modifyEffect: Operations["modifyEffect"] = (f) =>
			modifySomeEffect((value) =>
				f(value).pipe(
					Effect.map(([result, next]) => [result, Option.some(next)] as const),
				),
			)
		const modify: Operations["modify"] = (f) =>
			modifyEffect((value) => Effect.sync(() => f(value)))
		const modifySome: Operations["modifySome"] = (f) =>
			modifySomeEffect((value) => Effect.sync(() => f(value)))
		return {
			definition: input.plugin.store.definition,
			snapshot,
			get: Effect.map(snapshot, ({ value }) => value),
			setAt: (request) =>
				Effect.gen(function* () {
					const context = yield* Bot.Context,
						at = yield* context.at
					if (at.chat !== request.base.chat)
						return yield* new Chat.ChatError({
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
			modifyEffect,
			modifySome,
			modifySomeEffect,
			set: (value) => modify(() => [undefined, value]),
			getAndSet: (value) => modify((previous) => [previous, value]),
			setAndGet: (value) => modify(() => [value, value]),
			update: (f) => modify((value) => [undefined, f(value)]),
			getAndUpdate: (f) => modify((value) => [value, f(value)]),
			updateAndGet: (f) =>
				modify((value) => {
					const next = f(value)
					return [next, next]
				}),
			updateEffect: (f) =>
				modifyEffect((value) =>
					f(value).pipe(Effect.map((next) => [undefined, next] as const)),
				),
			getAndUpdateEffect: (f) =>
				modifyEffect((value) =>
					f(value).pipe(Effect.map((next) => [value, next] as const)),
				),
			updateAndGetEffect: (f) =>
				modifyEffect((value) =>
					f(value).pipe(Effect.map((next) => [next, next] as const)),
				),
			updateSome: (f) => modifySome((value) => [undefined, f(value)]),
			getAndUpdateSome: (f) => modifySome((value) => [value, f(value)]),
			updateSomeAndGet: (f) =>
				modifySome((value) => {
					const next = f(value)
					return [Option.getOrElse(next, () => value), next]
				}),
			updateSomeEffect: (f) =>
				modifySomeEffect((value) =>
					f(value).pipe(Effect.map((next) => [undefined, next] as const)),
				),
			getAndUpdateSomeEffect: (f) =>
				modifySomeEffect((value) =>
					f(value).pipe(Effect.map((next) => [value, next] as const)),
				),
			updateSomeAndGetEffect: (f) =>
				modifySomeEffect((value) =>
					f(value).pipe(
						Effect.map(
							(next) => [Option.getOrElse(next, () => value), next] as const,
						),
					),
				),
		}
	})
