import { Effect, Option, Record as EffectRecord } from "effect"
import * as Session from "../session/Session.ts"
import * as Agent from "../agent/Agent.ts"
import type * as Timeline from "../timeline/Timeline.ts"
import type * as Plugin from "./Plugin.ts"
import type * as SessionStore from "../store/SessionStore.ts"

export const make = <P, D extends Plugin.StateDeclaration>(input: {
	readonly store: Pick<SessionStore.Store<P>, "read" | "modifyEffect">
	readonly plugin: Plugin.Definition & {
		readonly store: { readonly definition: D }
	}
}): Effect.Effect<Plugin.Store<D, Session.SessionError, Agent.Context>> =>
	Effect.gen(function* () {
		type A = D["schema"]["Type"]
		type Operations = Plugin.StoreOperations<
			A,
			Session.SessionError,
			Agent.Context
		>
		const key = input.plugin.id
		const scoped = (view: Session.View<P>) =>
			input.plugin.store.definition.scope === "timeline"
				? view.state.value
				: view.session.business
		const read = (view: Session.View<P>): Option.Option<A> =>
			Option.fromUndefinedOr(scoped(view)[key] as A | undefined)
		const replace = (
			view: Session.View<P>,
			data: Option.Option<A>,
		): SessionStore.Mutation<P> => {
			const value = Option.match(data, {
				onNone: () => EffectRecord.remove(scoped(view), key),
				onSome: (data) => ({ ...scoped(view), [key]: data }),
			})
			return input.plugin.store.definition.scope === "timeline"
				? { value: value as Timeline.Value<P> }
				: { session: { business: value } }
		}
		const snapshot: Operations["snapshot"] = Effect.gen(function* () {
			const context = yield* Agent.Context,
				at = yield* context.at,
				view = yield* input.store.read(at.session)
			return {
				at: Session.position(view.session),
				value: read(view),
			}
		})
		const modifySomeEffect: Operations["modifySomeEffect"] = (f) =>
			Effect.gen(function* () {
				const context = yield* Agent.Context,
					at = yield* context.at
				const changed = yield* input.store.modifyEffect({
					session: at.session,
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
					const context = yield* Agent.Context,
						at = yield* context.at
					if (at.session !== request.base.session)
						return yield* new Session.SessionError({
							reason: "state-conflict",
							message: "The plugin store is bound to a different branch",
						})
					const { view } = yield* input.store.modifyEffect({
						session: at.session,
						expectedRevision: request.base.revision,
						expectedHead: request.base.version,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some(replace(current, request.value)),
							] as const),
					})
					return view.session
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
