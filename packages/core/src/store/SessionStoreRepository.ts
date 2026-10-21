import {
	Cache,
	Context,
	Effect,
	Match,
	Equal,
	Exit,
	HashSet,
	Layer,
	Option,
	PubSub,
	Schema,
	Semaphore,
	Stream,
	type Scope,
} from "effect"
import { dual } from "effect/Function"
import { IdGenerator } from "effect/ai"
import * as Session from "../session/Session.ts"
import * as Turn from "../session/Turn.ts"
import * as Timeline from "../timeline/Timeline.ts"
import { initial, fullHistory, coherent } from "../timeline/TimelineState.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import * as SessionStore from "./SessionStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import * as Snapshots from "./Snapshots.ts"
import * as RecordSerialization from "./RecordSerialization.ts"
import * as Store from "./Store.ts"
import * as VersionGraph from "./VersionGraph.ts"
import { omitOptional } from "./PromptCodec.ts"
import { error, invalid } from "./StoreErrors.ts"

type CodecServices<S extends Plugin.Stores> =
	SessionStore.DecodingServices<S> | SessionStore.EncodingServices<S>
export const make = <S extends Plugin.Stores>(
	options: SessionStore.Options<S>,
): Effect.Effect<
	SessionStore.Store<SessionStore.Plugins<S>>,
	never,
	Scope.Scope | CodecServices<S>
> =>
	Effect.gen(function* () {
		type P = SessionStore.Plugins<S>
		type Loaded = {
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
			readonly raw: Schema.JsonObject
			readonly state: Timeline.State<P>
		}
		const services = yield* Effect.context<CodecServices<S>>()
		const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
			Effect.provideContext(program, services)
		const storage = options.persistence
		// All writes run one at a time.
		const atomic = (yield* Semaphore.make(1)).withPermits(1)
		const bus = yield* PubSub.unbounded<SessionStore.Change<P>>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		const publish = (change: SessionStore.Change<P>) =>
			Effect.sync(() => {
				PubSub.publishUnsafe(bus, change)
			})
		const generator = Option.getOrElse(
			yield* Effect.serviceOption(IdGenerator.IdGenerator),
			() => IdGenerator.defaultIdGenerator,
		)
		const id = () => generator.generateId()
		const encodeRef = (ref: Session.Ref) =>
			provide(
				Schema.encodeEffect(options.definition.sessionSchema)(ref).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Session.Ref)),
					Effect.mapError(invalid),
				),
			)
		const decodeRef = (ref: Session.Ref) =>
			provide(
				Schema.encodeEffect(Session.Ref)(ref).pipe(
					Effect.flatMap((json) =>
						Schema.decodeUnknownEffect(Schema.Json)(omitOptional(json)),
					),
					Effect.flatMap(Schema.decodeEffect(options.definition.sessionSchema)),
					Effect.mapError(invalid),
				),
			)
		const getRef = (session: Session.Id) =>
			storage.getRef(session).pipe(
				Effect.flatMap((ref) =>
					Effect.fromOption(
						ref,
						() => new Session.SessionNotFound({ session }),
					),
				),
				Effect.flatMap(decodeRef),
			)
		const cache = yield* Cache.makeWith(
			(version: Timeline.VersionId) =>
				provide(
					Effect.gen(function* () {
						const loaded = yield* Snapshots.readRaw(storage, version)
						return {
							...loaded,
							state: yield* Store.project(
								options.definition,
								loaded.snapshot,
								loaded.raw,
							),
						}
					}),
				),
			{
				capacity: 64,
				timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0),
			},
		)
		const load = (version: Timeline.VersionId) => Cache.get(cache, version)
		const readCurrent = (session: Session.Id) =>
			Effect.gen(function* () {
				const ref = yield* getRef(session)
				return { session: ref, state: (yield* load(ref.head)).state }
			})
		const persist = (delta: SessionStore.Delta, view?: Session.View<P>) =>
			Effect.gen(function* () {
				const encoded = {
					...delta,
					session: yield* encodeRef(delta.session),
					expected:
						delta.expected === null ? null : yield* encodeRef(delta.expected),
				}
				yield* options.onCommit === undefined
					? storage.save(encoded)
					: options.onCommit({
							delta: encoded,
							...(view === undefined ? {} : { view }),
						})
			})
		const save = (
			delta: SessionStore.Delta,
			view: Session.View<P>,
			timelineChanged: boolean,
		) =>
			Effect.uninterruptibleMask((restore) =>
				restore(persist(delta, view)).pipe(
					Effect.andThen(
						publish(
							timelineChanged
								? { _tag: "VersionCommitted", previous: delta.expected, view }
								: {
										_tag: "RefUpdated",
										previous: delta.expected,
										ref: view.session,
									},
						),
					),
				),
			)
		const encode = (value: Timeline.Value<P>) =>
			provide(
				Schema.encodeEffect(options.definition.schema)(value).pipe(
					Effect.mapError(
						(e) =>
							new SessionStore.SessionStoreError({
								reason: "encode-failed",
								message: "Failed to encode the Timeline",
								issue: e.issue,
							}),
					),
				),
			)
		/** The rows that a new Timeline version adds to the delta. */
		const packVersion = (
			version: Timeline.Version,
			value: Timeline.Value<P>,
			reusable: ReadonlyArray<Loaded>,
		) =>
			encode(value).pipe(
				Effect.flatMap((raw) => Snapshots.pack(version, raw, reusable, id)),
				Effect.map((packed) => ({
					versions: [packed.snapshot],
					messages: packed.messages,
				})),
			)
		const unchanged = { versions: [], messages: [] }
		const modifyEffect: SessionStore.Store<P>["modifyEffect"] = (input) =>
			atomic(
				Effect.gen(function* () {
					const before = yield* readCurrent(input.session)
					if (
						input.expectedRevision !== undefined &&
						input.expectedRevision !== before.session.revision
					)
						return yield* error("reference-conflict", {
							message: "The Session revision is out of date",
						})
					if (
						input.expectedHead !== undefined &&
						input.expectedHead !== before.session.head
					)
						return yield* error("reference-conflict", {
							message: "The Timeline head is out of date",
						})
					const [result, next] = yield* input.update(before)
					if (Option.isNone(next)) return { result, view: before }
					const mutation = next.value
					const changed =
						mutation.value !== undefined &&
						!Equal.equals(mutation.value, before.state.value)
					if (!changed && mutation.session === undefined)
						return { result, view: before }
					const version: Timeline.Version = changed
						? {
								id: Timeline.VersionId.make(yield* id()),
								schemaVersion: options.definition.schemaVersion,
								parents: [before.session.head],
							}
						: before.state.version
					const value = mutation.value ?? before.state.value
					const ref: Session.Ref = {
						...before.session,
						...mutation.session,
						...(mutation.session?.turns === undefined
							? {}
							: {
									turns: mutation.session.turns.map((turn) =>
										Turn.isTerminal(turn.status) && turn.end === undefined
											? { ...turn, end: version.id }
											: turn,
									),
								}),
						head: version.id,
						revision: Session.Revision.make(before.session.revision + 1),
					}
					const view: Session.View<P> = {
						session: ref,
						state: changed ? { version, value } : before.state,
					}
					const packed = changed
						? yield* packVersion(version, value, [
								yield* load(before.session.head),
							])
						: unchanged
					yield* save(
						{ session: ref, expected: before.session, ...packed },
						view,
						changed,
					)
					return { result, view }
				}),
			)
		const newRef = (
			head: Timeline.VersionId,
			metadata: Session.MetadataInput,
			settings?: Partial<Turn.Settings>,
			business: Session.Ref["business"] = {},
		): Effect.Effect<Session.Ref> =>
			Effect.map(id(), (id) => ({
				id: Session.Id.make(id),
				head,
				revision: Session.Revision.make(0),
				metadata: { ...metadata, title: metadata.title ?? "", archived: false },
				settings: { mode: "default", memoryEnabled: true, ...settings },
				pending: [],
				turns: [],
				inheritedTurns: [],
				business,
			}))
		const create: SessionStore.Store<P>["create"] = (input) =>
			atomic(
				Effect.gen(function* () {
					const value = input.value ?? initial({} as P)
					const version: Timeline.Version = {
						id: Timeline.VersionId.make(yield* id()),
						schemaVersion: options.definition.schemaVersion,
						parents: [],
					}
					const ref = yield* newRef(
						version.id,
						input.metadata,
						input.settings,
						input.business,
					)
					const view = { session: ref, state: { version, value } }
					const packed = yield* packVersion(version, value, [])
					yield* save({ session: ref, expected: null, ...packed }, view, true)
					return view
				}),
			)
		const read: SessionStore.Store<P>["read"] = ((
			session: Session.Id,
			version?: Timeline.VersionId,
		) =>
			Effect.gen(function* () {
				const view = yield* readCurrent(session)
				if (version === undefined) return view
				const log = yield* VersionGraph.log(storage, view.session.head)
				if (!log.some((entry) => entry.id === version))
					return yield* new Timeline.VersionError({
						reason: "version-unreachable",
						version,
						message: "The Timeline version is not reachable from this Session",
					})
				return (yield* load(version)).state
			})) as SessionStore.Store<P>["read"]
		const fork: SessionStore.Store<P>["fork"] = (input) =>
			atomic(
				Effect.gen(function* () {
					const source = yield* readCurrent(input.source)
					const log = yield* VersionGraph.log(storage, source.session.head)
					const requested = input.version ?? source.session.head
					if (!log.some((version) => version.id === requested))
						return yield* new Timeline.VersionError({
							reason: "version-unreachable",
							version: requested,
							message: "The selected Timeline version is not reachable",
						})
					// Without an explicit version, walk back first parents to the last coherent Timeline version.
					const select = (
						candidate: Timeline.VersionId,
					): Effect.Effect<
						{ readonly id: Timeline.VersionId; readonly loaded: Loaded },
						SessionStore.SessionStoreError
					> =>
						load(candidate).pipe(
							Effect.flatMap((loaded) => {
								if (coherent(loaded.state.value))
									return Effect.succeed({ id: candidate, loaded })
								const parent = loaded.snapshot.parents[0]
								return input.version !== undefined || parent === undefined
									? Effect.fail(
											error("reference-invalid", {
												message:
													"Fork needs a complete and coherent history boundary",
												version: candidate,
											}),
										)
									: select(parent)
							}),
						)
					const { id: selected, loaded: selectedLoaded } =
						yield* select(requested)
					const settings = { ...source.session.settings, ...input.settings }
					const selectedValue = selectedLoaded.state.value
					const context = Match.value(selectedValue.conversation.context).pipe(
						Match.tag("Native", (window) =>
							settings.model?.provider !== window.provider ||
							settings.model?.model !== window.model
								? ContextWindow.fromPrompt(fullHistory(selectedValue))
								: window,
						),
						Match.tag("Prompt", (window) => window),
						Match.exhaustive,
					)
					const value: Timeline.Value<P> =
						context === selectedValue.conversation.context
							? selectedValue
							: {
									...selectedValue,
									conversation: { ...selectedValue.conversation, context },
								}
					const adapted = !Equal.equals(value, selectedLoaded.state.value)
					const version: Timeline.Version = adapted
						? {
								id: Timeline.VersionId.make(yield* id()),
								schemaVersion: options.definition.schemaVersion,
								parents: [selected],
							}
						: selectedLoaded.state.version
					const originTurns = HashSet.fromIterable(
						value.conversation.history.flatMap((item) =>
							item.origin === undefined ? [] : [item.origin.turn],
						),
					)
					const ref = {
						...(yield* newRef(
							version.id,
							input.metadata ?? source.session.metadata,
							settings,
						)),
						forkedFrom: { session: source.session.id, version: selected },
						inheritedTurns: [
							...source.session.inheritedTurns,
							...source.session.turns,
						].filter(
							(turn) =>
								HashSet.has(originTurns, turn.id) &&
								Turn.isTerminal(turn.status),
						),
					}
					const view = { session: ref, state: { version, value } }
					const packed = adapted
						? yield* packVersion(version, value, [selectedLoaded])
						: unchanged
					yield* save(
						{ session: ref, expected: null, ...packed },
						view,
						adapted,
					)
					return view
				}),
			)
		const codec = RecordSerialization.make<S>()
		const store: SessionStore.Store<P> = {
			get: (session) =>
				storage.getRef(session).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeedNone,
							onSome: (ref) => decodeRef(ref).pipe(Effect.asSome),
						}),
					),
				),
			list: (input) =>
				storage
					.listRefs(input)
					.pipe(Effect.flatMap((refs) => Effect.forEach(refs, decodeRef))),
			read,
			create,
			fork,
			modifyEffect,
			getVersion: (version) =>
				storage
					.headers([version])
					.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0]))),
			readVersion: (version) =>
				load(version).pipe(Effect.map((loaded) => loaded.state)),
			commit: (input) =>
				modifyEffect({
					session: input.expected.id,
					expectedRevision: input.expected.revision,
					expectedHead: input.expected.head,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ value: input.value }),
						] as const),
				}).pipe(Effect.map((result) => result.view)),
			updateMetadata: (input) =>
				modifyEffect({
					session: input.expected.id,
					expectedRevision: input.expected.revision,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ session: { metadata: input.metadata } }),
						] as const),
				}).pipe(Effect.map((result) => result.view.session)),
			updateSettings: (input) =>
				modifyEffect({
					session: input.expected.id,
					expectedRevision: input.expected.revision,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({ session: { settings: input.settings } }),
						] as const),
				}).pipe(Effect.map((result) => result.view)),
			log: (input) => VersionGraph.log(storage, input.from),
			diff: (input) => VersionGraph.diff(storage, input.target, input.base),
			remove: (ref) =>
				atomic(
					Effect.gen(function* () {
						const encoded = yield* encodeRef(ref)
						yield* options.onRemove === undefined
							? storage.remove(encoded)
							: options.onRemove(encoded)
						yield* publish({ _tag: "RefRemoved", ref })
					}),
				),
			export: (session) =>
				Effect.gen(function* () {
					const view = yield* readCurrent(session)
					return yield* VersionGraph.exportRecord(
						storage,
						yield* encodeRef(view.session),
					)
				}),
			import: (input) =>
				Effect.gen(function* () {
					const text = yield* codec.encode({
						definition: options.definition,
						record: input.record,
					})
					const record = yield* codec.decode({
						definition: options.definition,
						input: text,
					})
					const decodedRef = yield* decodeRef(record.session)
					const ref =
						input.expected === null
							? decodedRef
							: {
									...decodedRef,
									revision: Session.Revision.make(input.expected.revision + 1),
								}
					const state = yield* codec.materialize({
						definition: options.definition,
						record,
					})
					const view = { session: ref, state }
					yield* save(
						{
							session: ref,
							expected: input.expected,
							versions: record.versions,
							messages: record.messages,
						},
						view,
						true,
					)
					return view
				}).pipe(provide, atomic),
			changes: (input) =>
				Stream.fromPubSub(bus).pipe(
					Stream.filter(
						(change) =>
							input?.session === undefined ||
							Match.value(change).pipe(
								Match.tag("VersionCommitted", ({ view }) => view.session.id),
								Match.orElse(({ ref }) => ref.id),
							) === input.session,
					),
				),
		}
		return store
	})
export const layer: {
	<S extends Plugin.Stores>(
		options: SessionStore.Options<S>,
	): <I>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
	) => Layer.Layer<I, never, CodecServices<S>>
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
		options: SessionStore.Options<S>,
	): Layer.Layer<I, never, CodecServices<S>>
} = dual(
	2,
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
		options: SessionStore.Options<S>,
	) => Layer.effect(tag, make(options)),
)
