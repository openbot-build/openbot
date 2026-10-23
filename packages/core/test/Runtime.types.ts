import {
	Bot,
	Item,
	Timeline,
	Plugin,
	PluginState,
	PluginComposition,
	Session,
	SessionRuntime,
	SessionStore,
	SessionStoreRepository,
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
	readonly persistence: SessionStore.Persistence
	readonly session: Session.Id
	readonly ref: Session.Ref
	readonly version: Timeline.VersionId
	readonly record: SessionStore.Record
}) =>
	Effect.gen(function* () {
		const declaration = {
			scope: "timeline" as const,
			schema: input.schema,
		}
		const definition = yield* Store.define({
			stores: { counter: declaration },
			schemaVersion: "timeline/1",
		})
		const construction = SessionStoreRepository.make({
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
		const runtime = yield* SessionRuntime.make({ store, bot: { plugin } })
		const read = store.read(input.session),
			imported = store.import({ record: input.record, expected: null })
		const modified = store.modifyEffect({
			session: input.session,
			update: (current) =>
				Effect.flatMap(PluginDependency, (value) =>
					value < 0
						? Effect.fail("update-error" as const)
						: Effect.succeed([
								value,
								Option.some({
									value: { ...current.state.value, counter: value },
								}),
							] as const),
				),
		})
		const execution = runtime.execute({
			base: { session: input.session, revision: input.ref.revision },
			input: "input",
		})
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
			Assert<Effect.Services<typeof imported> extends never ? true : false>,
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
				Bot.Context extends Effect.Services<typeof ownUpdate> ? true : false
			>,
			Assert<
				"own-update-error" extends Effect.Error<typeof ownUpdate> ? true : false
			>,
		] = [true, true, true, true, true, true, true, true, true, true, true]
		return checks
	})
export const checkIdentities = ({
	session,
	turn,
	item,
	version,
	revision,
}: {
	readonly session: Session.Id
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly version: Timeline.VersionId
	readonly revision: Session.Revision
}) => {
	// @ts-expect-error A Turn cannot identify a Session.
	const wrongSession: Session.Id = turn
	// @ts-expect-error A Timeline version cannot identify a Turn.
	const wrongTurn: Turn.Id = version
	// @ts-expect-error An Item cannot identify a Timeline version.
	const wrongVersion: Timeline.VersionId = item
	// @ts-expect-error A model step cannot identify a Turn.
	const wrongStep: Turn.Id = 1
	// @ts-expect-error A Timeline head is not a Session revision.
	const wrongRevision: Session.Expected = { session, revision: version }
	const expected: Session.Expected = { session, revision }
	const control: { readonly session: Session.Id; readonly turn: Turn.Id } = {
		session,
		turn,
	}
	return {
		wrongSession,
		wrongTurn,
		wrongVersion,
		wrongStep,
		wrongRevision,
		expected,
		control,
	}
}

class ConstructionDependency extends Context.Service<
	ConstructionDependency,
	number
>()("@openbot-build/core/test/Runtime.types/ConstructionDependency") {}
export const checkHostConstructionChannels = (input: {
	readonly store: SessionStore.Store
	readonly base: Session.Input["base"]
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
		const construction = SessionRuntime.make({
			store: input.store,
			bot: { hostPlugin },
		})
		const runtime = yield* construction
		const execution = runtime.execute({ base: input.base, input: "Continue" })
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
	base,
}: {
	readonly store: SessionStore.Store
	readonly base: Session.Expected
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
				{ scope: "session", schema: Schema.String },
			),
		)
		const construction = SessionRuntime.make({
			store,
			bot: { plugin: combined },
		})
		const runtime = yield* construction
		const execution = runtime.execute({ base, input: "input" })
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
